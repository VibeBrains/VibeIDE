/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeAgentRenderedUIService — safe rendering of structured UI from agent responses (A2UI).
 *
 * Allows the agent to embed a limited, allowlisted set of UI components in its chat
 * response, rather than walls of plain text. This improves UX for structured outputs
 * (tables, progress bars, key-value summaries, action buttons) without opening XSS vectors.
 *
 * Security model:
 *  - Only an explicit allowlist of component types is accepted; unknown types are stripped
 *  - All string values pass through VibePromptGuardService.sanitizeFileContent (injection check)
 *  - Behind feature flag `vibeide.agentUI.enabled` (default: false — speculative)
 *  - CSP-equivalent: no script execution, no external resource loading
 *  - Rendered in a sandboxed webview or inline DOM via allowlisted elements only
 *
 * Supported component types (MVP):
 *  - `table`: key-value or tabular data
 *  - `progress`: named progress bar (percent + label)
 *  - `summary`: collapsible key-value card
 *  - `action_buttons`: 1-3 labelled buttons that fire named commands
 *
 * Phase MVP: parse + validate + sanitize. Rendering hooks — Phase 3b (webview integration).
 *
 * Note: "speculative" as per roadmap — behind feature flag, not enabled in default config.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IVibePromptGuardService } from './vibePromptGuardService.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.agentUI.enabled': {
			type: 'boolean',
			default: false,
			tags: ['experimental'],
			description: localize('vibeide.agentUI.enabled', '[Experimental] Разрешить агенту рендерить структурированные UI-компоненты (таблицы, прогресс-бары, кнопки) в ответах чата. Под feature flag.'),
		},
		'vibeide.agentUI.allowedComponents': {
			type: 'array',
			items: { type: 'string', enum: ['table', 'progress', 'summary', 'action_buttons'] },
			default: ['table', 'progress', 'summary'],
			description: localize('vibeide.agentUI.allowedComponents', 'Какие типы структурированных UI-компонентов разрешено рендерить агенту.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type AgentUIComponentType = 'table' | 'progress' | 'summary' | 'action_buttons';

export interface AgentUITable {
	type: 'table';
	headers: string[];
	rows: string[][];
}

export interface AgentUIProgress {
	type: 'progress';
	label: string;
	percent: number; // 0-100
}

export interface AgentUISummary {
	type: 'summary';
	title: string;
	fields: Array<{ key: string; value: string }>;
	collapsed?: boolean;
}

export interface AgentUIActionButtons {
	type: 'action_buttons';
	buttons: Array<{ label: string; command: string; args?: string[] }>;
}

export type AgentUIComponent = AgentUITable | AgentUIProgress | AgentUISummary | AgentUIActionButtons;

export interface AgentUIBlock {
	/** Parsed and sanitized components */
	components: AgentUIComponent[];
	/** Whether any components were stripped (security policy or feature flag) */
	hadViolations: boolean;
}

export const IVibeAgentRenderedUIService = createDecorator<IVibeAgentRenderedUIService>('vibeAgentRenderedUIService');

export interface IVibeAgentRenderedUIService {
	readonly _serviceBrand: undefined;

	/** Whether A2UI feature is enabled */
	isEnabled(): boolean;

	/**
	 * Parse and sanitize an agent UI block from a JSON string embedded in the agent response.
	 * Returns null if the feature is disabled or parsing fails.
	 */
	parseAndSanitize(json: string): AgentUIBlock | null;

	/**
	 * Validate a single component against the allowlist.
	 * Returns null if the component type is not allowed.
	 */
	validateComponent(component: unknown): AgentUIComponent | null;
}

// ── Implementation ─────────────────────────────────────────────────────────────

const MAX_TABLE_ROWS = 100;
const MAX_CELL_CHARS = 500;
const MAX_BUTTONS = 3;

/**
 * Positive allowlist of commands the agent is allowed to invoke from
 * `action_buttons`. Mirrors `references/v1/a2ui-allowed-commands.md`. Adding a command
 * here is a security decision — keep this constant in sync with the doc table and require
 * a reviewer outside the original author for any change (label `a2ui-allowlist-change`).
 *
 * Explicitly NOT in the list:
 *   - vibeide.commands.run.<id> (Project Commands shell exec — needs consent dialog)
 *   - vibeide.skills.importCommunityUrl (writes content; consent is user-driven)
 *   - vibeide.skills.saveAsFromChat (writes new files under .vibe/skills)
 *   - vibeide.emergencyStopAllAgents (destructive; terminates running sessions)
 *   - workbench.action.* / vscode.* (out of scope)
 */
export const A2UI_ALLOWED_COMMANDS: readonly string[] = Object.freeze([
	'vibeide.openSettings',
	'vibeide.context.attachApiSpec',
	'vibeide.context.pickDiagram',
	'vibeide.context.previewDiagram',
	'vibeide.skills.pickSession',
	'vibeide.skills.showFolder',
	'vibeide.skills.newTemplate',
	'vibeide.plans.newInWorkspace',
	'vibeide.plans.showPlansFolder',
	'vibeide.plans.bindingSnapshot',
	'vibeide.plans.findSimilar',
	'vibeide.plans.explainRisk',
	'vibeide.copyIssueReport',
	'vibeide.chat.cycleMode',
]);

/**
 * Pure helper. Returns true iff `commandId` is in the A2UI positive allowlist.
 */
export function isA2UICommandAllowed(commandId: string | unknown): boolean {
	return typeof commandId === 'string' && A2UI_ALLOWED_COMMANDS.includes(commandId);
}

class VibeAgentRenderedUIService extends Disposable implements IVibeAgentRenderedUIService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibePromptGuardService private readonly _guard: IVibePromptGuardService,
	) {
		super();
	}

	isEnabled(): boolean {
		return !!this._config.getValue<boolean>('vibeide.agentUI.enabled');
	}

	parseAndSanitize(json: string): AgentUIBlock | null {
		if (!this.isEnabled()) { return null; }

		let raw: unknown;
		try {
			raw = JSON.parse(json);
		} catch {
			return null;
		}

		if (!Array.isArray(raw)) { return null; }

		const components: AgentUIComponent[] = [];
		let hadViolations = false;

		for (const item of raw) {
			const validated = this.validateComponent(item);
			if (validated) {
				components.push(validated);
			} else {
				hadViolations = true;
			}
		}

		return { components, hadViolations };
	}

	validateComponent(component: unknown): AgentUIComponent | null {
		if (typeof component !== 'object' || component === null) { return null; }
		const raw = component as Record<string, unknown>;
		const type = raw['type'] as string;

		const allowedTypes = this._config.getValue<string[]>('vibeide.agentUI.allowedComponents') ?? [];
		if (!allowedTypes.includes(type)) { return null; }

		switch (type as AgentUIComponentType) {
			case 'table': return this._validateTable(raw);
			case 'progress': return this._validateProgress(raw);
			case 'summary': return this._validateSummary(raw);
			case 'action_buttons': return this._validateButtons(raw);
			default: return null;
		}
	}

	private _sanitizeStr(s: unknown, maxChars = MAX_CELL_CHARS): string {
		if (typeof s !== 'string') { return ''; }
		const result = this._guard.sanitizeFileContent(s.slice(0, maxChars), '<agent-ui>');
		return result.sanitized;
	}

	private _validateTable(raw: Record<string, unknown>): AgentUITable | null {
		const headers = Array.isArray(raw['headers']) ? (raw['headers'] as unknown[]).map(h => this._sanitizeStr(h)) : [];
		const rows = Array.isArray(raw['rows'])
			? (raw['rows'] as unknown[]).slice(0, MAX_TABLE_ROWS).map(row =>
				Array.isArray(row) ? (row as unknown[]).map(cell => this._sanitizeStr(cell)) : []
			)
			: [];
		return { type: 'table', headers, rows };
	}

	private _validateProgress(raw: Record<string, unknown>): AgentUIProgress | null {
		const label = this._sanitizeStr(raw['label'], 200);
		const percent = Math.min(100, Math.max(0, Number(raw['percent']) || 0));
		return { type: 'progress', label, percent };
	}

	private _validateSummary(raw: Record<string, unknown>): AgentUISummary | null {
		const title = this._sanitizeStr(raw['title'], 200);
		const fields = Array.isArray(raw['fields'])
			? (raw['fields'] as unknown[]).slice(0, 50).map(f => {
				if (typeof f !== 'object' || f === null) { return null; }
				const fRaw = f as Record<string, unknown>;
				return { key: this._sanitizeStr(fRaw['key'], 100), value: this._sanitizeStr(fRaw['value']) };
			}).filter(Boolean) as Array<{ key: string; value: string }>
			: [];
		return { type: 'summary', title, fields, collapsed: !!raw['collapsed'] };
	}

	private _validateButtons(raw: Record<string, unknown>): AgentUIActionButtons | null {
		const buttons = Array.isArray(raw['buttons'])
			? (raw['buttons'] as unknown[]).slice(0, MAX_BUTTONS).map(b => {
				if (typeof b !== 'object' || b === null) { return null; }
				const bRaw = b as Record<string, unknown>;
				const label = this._sanitizeStr(bRaw['label'], 80);
				// Command must be in the A2UI positive allowlist — strip everything else.
				// Prefix-only filter (vibeide.*) was insufficient: vibeide.commands.run.<id>
				// would have routed the agent through Project Commands' shell exec without
				// consent. See references/v1/a2ui-allowed-commands.md.
				const command = isA2UICommandAllowed(bRaw['command']) ? bRaw['command'] as string : '';
				if (!command) { return null; }
				return { label, command };
			}).filter(Boolean) as Array<{ label: string; command: string }>
			: [];
		if (buttons.length === 0) { return null; }
		return { type: 'action_buttons', buttons };
	}
}

registerSingleton(IVibeAgentRenderedUIService, VibeAgentRenderedUIService, InstantiationType.Delayed);
