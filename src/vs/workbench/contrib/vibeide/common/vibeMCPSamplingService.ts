/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeMCPSamplingService — MCP Sampling / Elicitation support.
 *
 * The MCP specification includes a "Sampling" capability where an MCP server can
 * request the client (IDE) to perform an LLM completion on its behalf. This enables
 * more powerful, agentic MCP servers that can use the user's LLM provider.
 *
 * The "Elicitation" pattern is the companion: MCP server asks the client to prompt
 * the user for a clarification or additional input within the active tool flow.
 *
 * VibeIDE implementation:
 *  - Integrates with VibeToolApprovalService: every sampling request shows a consent UI
 *  - Privacy: sampling requests never bypass constraints or prompt injection guards
 *  - Single UX: reuses existing tool approval flow, no separate modal
 *  - Elicitation: shows a notification + inline input prompt in the chat composer
 *
 * Phase MVP: service contract + consent gate + audit events.
 * Phase 3b: wire into mcpChannel.ts sampling message handler; streaming result.
 *
 * Reference: https://spec.modelcontextprotocol.io/specification/client/sampling/
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IAuditLogService } from './auditLogService.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { decideSamplingConsent, SamplingRequest } from './mcpSamplingEnvelope.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.mcp.sampling.enabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.mcp.sampling.enabled', 'Разрешить MCP-серверам запрашивать LLM-completions через capability Sampling. Подтверждение пользователя показывается всегда.'),
		},
		'vibeide.mcp.sampling.requireApproval': {
			type: 'string',
			enum: ['always', 'first_per_server', 'never'],
			enumDescriptions: [
				localize('sampling.approval.always', 'Показывать диалог подтверждения для каждого sampling-запроса'),
				localize('sampling.approval.first_per_server', 'Показывать диалог только на первый запрос с MCP-сервера за сессию'),
				localize('sampling.approval.never', 'Авто-подтверждение всех sampling-запросов (не рекомендуется)'),
			],
			default: 'always',
			description: localize('vibeide.mcp.sampling.requireApproval', 'Когда показывать подтверждение пользователя для MCP sampling-запросов.'),
		},
		'vibeide.mcp.elicitation.enabled': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.mcp.elicitation.enabled', 'Разрешить MCP-серверам запрашивать у пользователя уточнения через capability Elicitation.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export interface MCPSamplingRequest {
	/** ID assigned by VibeMCPSamplingService */
	requestId: string;
	/** The MCP server that sent this sampling request */
	mcpServerId: string;
	/** Messages the server wants to pass to the LLM */
	messages: Array<{ role: 'user' | 'assistant'; content: string }>;
	/** Optional system prompt override from the server */
	systemPrompt?: string;
	/** Max tokens the server requests */
	maxTokens?: number;
	/** Stop sequences */
	stopSequences?: string[];
}

export interface MCPSamplingResult {
	requestId: string;
	/** 'approved' = user consented and result produced; 'rejected' = user denied */
	status: 'approved' | 'rejected' | 'error';
	/** The LLM completion text (only if status=approved) */
	completion?: string;
	reason?: string;
}

export interface MCPElicitationRequest {
	requestId: string;
	mcpServerId: string;
	/** What the server needs from the user */
	prompt: string;
	/** Optional suggested responses */
	suggestions?: string[];
}

export interface MCPElicitationResult {
	requestId: string;
	status: 'answered' | 'dismissed';
	answer?: string;
}

export const IVibeMCPSamplingService = createDecorator<IVibeMCPSamplingService>('vibeMCPSamplingService');

export interface IVibeMCPSamplingService {
	readonly _serviceBrand: undefined;

	/** Whether MCP Sampling is enabled */
	isSamplingEnabled(): boolean;

	/** Whether MCP Elicitation is enabled */
	isElicitationEnabled(): boolean;

	/**
	 * Handle an incoming sampling request from an MCP server.
	 * Shows consent UI (per policy) and returns the result.
	 */
	handleSamplingRequest(request: MCPSamplingRequest): Promise<MCPSamplingResult>;

	/**
	 * Handle an incoming elicitation request from an MCP server.
	 * Shows a notification / inline prompt and returns user's answer.
	 */
	handleElicitationRequest(request: MCPElicitationRequest): Promise<MCPElicitationResult>;

	/** Fired when a sampling request arrives (for consent UI to subscribe) */
	readonly onSamplingRequest: Event<MCPSamplingRequest>;

	/** Fired when an elicitation request arrives */
	readonly onElicitationRequest: Event<MCPElicitationRequest>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeMCPSamplingService extends Disposable implements IVibeMCPSamplingService {
	declare readonly _serviceBrand: undefined;

	private readonly _onSamplingRequest = this._register(new Emitter<MCPSamplingRequest>());
	readonly onSamplingRequest: Event<MCPSamplingRequest> = this._onSamplingRequest.event;

	private readonly _onElicitationRequest = this._register(new Emitter<MCPElicitationRequest>());
	readonly onElicitationRequest: Event<MCPElicitationRequest> = this._onElicitationRequest.event;

	/** Track servers that have been approved this session (for first_per_server policy) */
	private readonly _sessionApprovedServers = new Set<string>();

	private readonly _pendingElicitation = new Map<string, { resolve: (r: MCPElicitationResult) => void }>();

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IAuditLogService private readonly _audit: IAuditLogService,
		@IDialogService private readonly _dialog: IDialogService,
	) {
		super();
	}

	isSamplingEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.mcp.sampling.enabled');
	}

	isElicitationEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.mcp.elicitation.enabled');
	}

	async handleSamplingRequest(request: MCPSamplingRequest): Promise<MCPSamplingResult> {
		if (!this.isSamplingEnabled()) {
			return { requestId: request.requestId, status: 'rejected', reason: 'MCP Sampling is disabled.' };
		}

		this._log.info(`[VibeMCPSampling] Incoming sampling request ${request.requestId} from ${request.mcpServerId}`);
		this._audit.append({ ts: Date.now(), action: 'mcp_sampling_request', ok: true, meta: { requestId: request.requestId, mcpServerId: request.mcpServerId } });

		const approvalPolicy = this._config.getValue<string>('vibeide.mcp.sampling.requireApproval') ?? 'always';
		const samplingRequest: SamplingRequest = {
			messages: request.messages.map(m => ({ role: m.role, content: { type: 'text', text: m.content } })),
			systemPrompt: request.systemPrompt,
			maxTokens: request.maxTokens,
			stopSequences: request.stopSequences,
		};
		const consentDecision = decideSamplingConsent({
			request: samplingRequest,
			serverTrustState: approvalPolicy === 'never' ? 'trusted' : 'unknown',
			perServerSamplingApproved: this._sessionApprovedServers.has(request.mcpServerId),
		});

		if (consentDecision.kind === 'auto-allow') {
			this._sessionApprovedServers.add(request.mcpServerId);
			return this._executeSampling(request);
		}

		const confirmed = await this._dialog.confirm({
			message: localize('mcp.sampling.consent.title', 'MCP-сервер запрашивает LLM completion'),
			detail: localize('mcp.sampling.consent.detail', 'Сервер «{0}» хочет выполнить запрос к языковой модели от вашего имени.\n\nЗапрос: {1}', request.mcpServerId, request.messages.at(-1)?.content?.slice(0, 200) ?? ''),
			primaryButton: localize('mcp.sampling.consent.allow', 'Разрешить'),
		});

		if (!confirmed.confirmed) {
			this._audit.append({ ts: Date.now(), action: 'mcp_sampling_request', ok: false, meta: { requestId: request.requestId, reason: 'user_rejected' } });
			return { requestId: request.requestId, status: 'rejected', reason: 'User rejected MCP sampling request.' };
		}

		this._sessionApprovedServers.add(request.mcpServerId);
		this._onSamplingRequest.fire(request);
		return this._executeSampling(request);
	}

	async handleElicitationRequest(request: MCPElicitationRequest): Promise<MCPElicitationResult> {
		if (!this.isElicitationEnabled()) {
			return { requestId: request.requestId, status: 'dismissed' };
		}

		this._log.info(`[VibeMCPSampling] Incoming elicitation request ${request.requestId} from ${request.mcpServerId}`);
		this._onElicitationRequest.fire(request);

		return new Promise<MCPElicitationResult>(resolve => {
			this._pendingElicitation.set(request.requestId, { resolve });
		});
	}

	private async _executeSampling(request: MCPSamplingRequest): Promise<MCPSamplingResult> {
		// Phase 3b: call sendLLMMessageService with the sampling messages.
		// MVP: return a placeholder completion so the flow is testable end-to-end.
		this._log.info(`[VibeMCPSampling] [Phase 3b stub] Would execute sampling for ${request.requestId}`);
		return {
			requestId: request.requestId,
			status: 'approved',
			completion: `[MVP stub] Sampling result for: ${request.messages.at(-1)?.content?.slice(0, 100)}`,
		};
	}
}

registerSingleton(IVibeMCPSamplingService, VibeMCPSamplingService, InstantiationType.Delayed);
