/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Background agent runtime (roadmap §L884).
 *
 * Spawns `vibe-agent-run.js` as an unattended runner and drives the lifecycle
 * FSM defined in `common/backgroundAgentIPC.ts`. JSON-line envelopes flow over
 * the child's stdin/stdout; outbound envelopes (IDE → runner) are validated
 * by `decodeInboundEnvelope` and inbound (runner → IDE) by `decodeOutbound...`.
 *
 * One runner per session id. The service surfaces lifecycle events so the UI
 * can render progress, pause/resume, and abort buttons without knowing about
 * the underlying transport.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import {
	BACKGROUND_AGENT_PROTOCOL_VERSION,
	BgAgentEnvelope,
	BgAgentInboundType,
	BgAgentOutboundType,
	BgAgentState,
	BgAgentEvent,
	buildOutboundEnvelope,
	decodeOutboundEnvelope,
	transitionBgAgent,
} from '../common/backgroundAgentIPC.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.backgroundAgent.enabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.backgroundAgent.enabled', 'Разрешить запуск фонового агента (vibe-agent-run.js) для длительных unattended-задач. Если выключено, `spawn()` вернёт ошибку. По умолчанию выключено.'),
		},
		'vibeide.backgroundAgent.maxConcurrentSessions': {
			type: 'number',
			default: 2,
			minimum: 1,
			maximum: 16,
			description: localize('vibeide.backgroundAgent.maxConcurrentSessions', 'Максимум одновременно запущенных background-agent сессий. Превышение приведёт к ошибке spawn. По умолчанию 2.'),
		},
	},
});

export interface BackgroundAgentSpawnRequest {
	readonly sessionId?: string;
	readonly entryScript?: string;
	readonly task: string;
	readonly env?: Readonly<Record<string, string>>;
	readonly cwd?: string;
}

export interface BackgroundAgentSession {
	readonly sessionId: string;
	readonly state: BgAgentState;
	send(type: BgAgentInboundType, payload: unknown): boolean;
	abort(reason: string): void;
}

export interface BackgroundAgentSessionEvent {
	readonly sessionId: string;
	readonly state: BgAgentState;
	readonly envelope?: BgAgentEnvelope<BgAgentOutboundType>;
}

export const IVibeBackgroundAgentRuntime = createDecorator<IVibeBackgroundAgentRuntime>('vibeBackgroundAgentRuntime');

export interface IVibeBackgroundAgentRuntime {
	readonly _serviceBrand: undefined;
	spawn(req: BackgroundAgentSpawnRequest): BackgroundAgentSession;
	get(sessionId: string): BackgroundAgentSession | undefined;
	readonly onDidUpdate: Event<BackgroundAgentSessionEvent>;
}

class VibeBackgroundAgentRuntime extends Disposable implements IVibeBackgroundAgentRuntime {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidUpdate = this._register(new Emitter<BackgroundAgentSessionEvent>());
	readonly onDidUpdate: Event<BackgroundAgentSessionEvent> = this._onDidUpdate.event;

	private readonly _sessions = new Map<string, InternalSession>();

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
	}

	spawn(req: BackgroundAgentSpawnRequest): BackgroundAgentSession {
		const enabled = this._config.getValue<boolean>('vibeide.backgroundAgent.enabled') === true;
		if (!enabled) {
			throw new Error('background-agent: disabled via vibeide.backgroundAgent.enabled');
		}
		const maxSessions = Math.max(1, Math.min(16, this._config.getValue<number>('vibeide.backgroundAgent.maxConcurrentSessions') ?? 2));
		if (this._sessions.size >= maxSessions) {
			throw new Error(`background-agent: at maxConcurrentSessions=${maxSessions}`);
		}
		const sessionId = req.sessionId ?? generateUuid();
		if (this._sessions.has(sessionId)) {
			throw new Error(`background-agent: session already exists: ${sessionId}`);
		}

		const cp = require('child_process') as typeof import('child_process');
		// Default runner is the JSON-envelope skeleton; vibe-agent-run.js is the user-facing
		// MVP CLI (job-file based) with different semantics. Callers can override via entryScript.
		const script = req.entryScript ?? require('path').resolve(process.cwd(), 'scripts', 'vibe-bg-agent-runner.js');
		const child = cp.fork(script, [], {
			env: {
				...process.env,
				...req.env,
				VIBE_AGENT_SESSION_ID: sessionId,
				VIBE_AGENT_PROTOCOL: String(BACKGROUND_AGENT_PROTOCOL_VERSION),
			},
			cwd: req.cwd ?? process.cwd(),
			silent: true,
			stdio: ['pipe', 'pipe', 'pipe', 'ipc'],
		});

		const session: InternalSession = {
			sessionId,
			state: { kind: 'starting', startedAtMs: Date.now() },
			child,
			lineBuf: '',
		};
		this._sessions.set(sessionId, session);

		// Drive `start` transition locally; runner is expected to emit `ready`.
		this._applyEvent(session, { kind: 'start', nowMs: Date.now() });

		child.stdout?.on('data', (b: Buffer) => this._onStdout(session, b));
		child.stderr?.on('data', (b: Buffer) => this._log.warn(`[VibeBgAgent ${sessionId}] stderr: ${b.toString('utf8')}`));
		child.on('exit', (code: number | null) => {
			this._log.info(`[VibeBgAgent ${sessionId}] exited code=${code ?? 'null'}`);
			if (session.state.kind !== 'done') {
				this._applyEvent(session, { kind: 'done', nowMs: Date.now(), outcome: code === 0 ? 'success' : 'failure' });
			}
			this._sessions.delete(sessionId);
		});
		child.on('error', (e: Error) => {
			this._log.error(`[VibeBgAgent ${sessionId}] error:`, e.message);
		});

		// Send initial start envelope to the runner (typed inbound).
		const startEnv = buildOutboundEnvelope('progress', sessionId, { phase: 'spawned' });
		if (startEnv.ok) {
			this._writeInbound(session, 'start', { task: req.task });
		}

		return this._toPublic(session);
	}

	get(sessionId: string): BackgroundAgentSession | undefined {
		const s = this._sessions.get(sessionId);
		return s ? this._toPublic(s) : undefined;
	}

	private _toPublic(s: InternalSession): BackgroundAgentSession {
		return {
			sessionId: s.sessionId,
			get state() { return s.state; },
			send: (type: BgAgentInboundType, payload: unknown) => this._writeInbound(s, type, payload),
			abort: (reason: string) => {
				this._writeInbound(s, 'abort', { reason });
				this._applyEvent(s, { kind: 'abort', reason });
				try { s.child.kill('SIGTERM'); } catch { /* swallow */ }
			},
		};
	}

	private _writeInbound(s: InternalSession, type: BgAgentInboundType, payload: unknown): boolean {
		const env: BgAgentEnvelope<BgAgentInboundType> = {
			type,
			version: BACKGROUND_AGENT_PROTOCOL_VERSION,
			correlationId: s.sessionId,
			payload,
		};
		try {
			const line = JSON.stringify(env) + '\n';
			return s.child.stdin?.write(line) ?? false;
		} catch (e) {
			this._log.warn('[VibeBgAgent] write failed:', e);
			return false;
		}
	}

	private _onStdout(s: InternalSession, b: Buffer): void {
		s.lineBuf += b.toString('utf8');
		let nl = s.lineBuf.indexOf('\n');
		while (nl >= 0) {
			const line = s.lineBuf.slice(0, nl).trim();
			s.lineBuf = s.lineBuf.slice(nl + 1);
			nl = s.lineBuf.indexOf('\n');
			if (line.length === 0) { continue; }
			try {
				const parsed = JSON.parse(line);
				const decoded = decodeOutboundEnvelope(parsed);
				if (!decoded.ok) {
					this._log.warn(`[VibeBgAgent ${s.sessionId}] decode-refused: ${decoded.reason}`);
					continue;
				}
				this._onOutboundEnvelope(s, decoded.value);
			} catch (e) {
				this._log.warn(`[VibeBgAgent ${s.sessionId}] non-JSON line: ${truncate(line, 120)}`);
			}
		}
	}

	private _onOutboundEnvelope(s: InternalSession, env: BgAgentEnvelope<BgAgentOutboundType>): void {
		switch (env.type) {
			case 'ready':
				this._applyEvent(s, { kind: 'ready', nowMs: Date.now() }, env);
				break;
			case 'progress': {
				const p = env.payload as { stepsCompleted?: number } | null;
				this._applyEvent(s, { kind: 'progress', stepsCompleted: Math.max(0, p?.stepsCompleted ?? 0) }, env);
				break;
			}
			case 'done': {
				const p = env.payload as { outcome?: 'success' | 'failure' } | null;
				this._applyEvent(s, { kind: 'done', nowMs: Date.now(), outcome: p?.outcome ?? 'success' }, env);
				break;
			}
			case 'error':
				this._log.warn(`[VibeBgAgent ${s.sessionId}] runner-error:`, env.payload);
				this._onDidUpdate.fire({ sessionId: s.sessionId, state: s.state, envelope: env });
				break;
			case 'log':
			case 'tool-request':
			case 'tool-result':
				this._onDidUpdate.fire({ sessionId: s.sessionId, state: s.state, envelope: env });
				break;
		}
	}

	private _applyEvent(s: InternalSession, ev: BgAgentEvent, envelope?: BgAgentEnvelope<BgAgentOutboundType>): void {
		const t = transitionBgAgent(s.state, ev);
		if (!t.ok) {
			this._log.warn(`[VibeBgAgent ${s.sessionId}] transition refused: ${t.reason} (from=${t.attemptedFrom} ev=${t.attemptedEvent})`);
			return;
		}
		s.state = t.next;
		this._onDidUpdate.fire({ sessionId: s.sessionId, state: s.state, envelope });
	}
}

interface InternalSession {
	readonly sessionId: string;
	state: BgAgentState;
	readonly child: import('child_process').ChildProcess;
	lineBuf: string;
}

function truncate(s: string, n: number): string {
	return s.length <= n ? s : s.slice(0, n) + '…';
}

registerSingleton(IVibeBackgroundAgentRuntime, VibeBackgroundAgentRuntime, InstantiationType.Delayed);
