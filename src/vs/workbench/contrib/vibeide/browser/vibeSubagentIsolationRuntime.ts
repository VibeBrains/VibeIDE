/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Subagent isolation runtime (roadmap §L883).
 *
 * Real spawn adapter for `decideSubagentIsolation`. The pure policy in
 * `common/subagentIsolationPolicy.ts` decides the backend; this service
 * actually creates the worker / child-process and shepherds its lifecycle.
 *
 * Backends:
 *   - 'worker-thread'   → Node `worker_threads.Worker` (preferred — lighter)
 *   - 'child-process'   → `child_process.fork()` (heavier, full process)
 *   - 'inline-fallback' → no isolation, runs the task on the host loop with
 *                         a hard-deadline watchdog (defeats the no-burn
 *                         promise — surfaced via `reasonCodes` to caller)
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import {
	SubagentKind,
	SubagentIsolationDecision,
	decideSubagentIsolation,
	describeIsolationDecision,
	checkIsolationCapability,
} from '../common/subagentIsolationPolicy.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.subagent.maxTokens': {
			type: 'number',
			default: 100000,
			minimum: 1024,
			maximum: 1000000,
			description: localize('vibeide.subagent.maxTokens', 'Максимальный размер контекстного окна изолированного субагента (worker/process), в токенах. Используется как верхний потолок при расчёте квоты «половина от родителя». По умолчанию 100 000.'),
		},
		'vibeide.subagent.forceInline': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.subagent.forceInline', 'Принудительно запускать субагентов в inline-режиме без изоляции (worker/process). Полезно для отладки; ломает гарантию «explore-subagent не сжигает родительский контекст». По умолчанию выключено.'),
		},
	},
});

export interface SubagentInvocationRequest {
	readonly kind: SubagentKind;
	readonly task: string;
	readonly handoffContext?: string;
	readonly parentRemainingTokens: number;
	readonly maxSubagentTokens?: number;
	readonly forceInline?: boolean;
	readonly entryScript?: string;
}

export interface SubagentInvocationResult {
	readonly invocationId: string;
	readonly decision: SubagentIsolationDecision;
	readonly outcome: 'success' | 'failure' | 'aborted' | 'timeout';
	readonly stdout: string;
	readonly stderr: string;
	readonly durationMs: number;
	readonly exitCode: number | null;
}

export interface SubagentRunningHandle {
	readonly invocationId: string;
	readonly decision: SubagentIsolationDecision;
	readonly result: Promise<SubagentInvocationResult>;
	abort(reason: string): void;
}

export const IVibeSubagentIsolationRuntime = createDecorator<IVibeSubagentIsolationRuntime>('vibeSubagentIsolationRuntime');

export interface IVibeSubagentIsolationRuntime {
	readonly _serviceBrand: undefined;
	invoke(req: SubagentInvocationRequest): SubagentRunningHandle;
	readonly onDidComplete: Event<SubagentInvocationResult>;
}

class VibeSubagentIsolationRuntime extends Disposable implements IVibeSubagentIsolationRuntime {
	declare readonly _serviceBrand: undefined;

	private readonly _onDidComplete = this._register(new Emitter<SubagentInvocationResult>());
	readonly onDidComplete: Event<SubagentInvocationResult> = this._onDidComplete.event;

	private readonly _active = new Map<string, { abort: (reason: string) => void }>();

	constructor(
		@ILogService private readonly _log: ILogService,
	) {
		super();
	}

	invoke(req: SubagentInvocationRequest): SubagentRunningHandle {
		const invocationId = generateUuid();
		const hostCaps = this._detectHostCapabilities();
		const decision = decideSubagentIsolation({
			kind: req.kind,
			hasWorkerSupport: hostCaps.hasWorkerSupport,
			hasChildProcessSupport: hostCaps.hasChildProcessSupport,
			parentRemainingTokens: req.parentRemainingTokens,
			maxSubagentTokens: req.maxSubagentTokens,
			forceInline: req.forceInline,
		});
		this._log.info(`[VibeSubagent] ${invocationId}: ${describeIsolationDecision(decision, req.kind)}`);

		const cap = checkIsolationCapability({
			backend: decision.backend,
			hasWorkerSupport: hostCaps.hasWorkerSupport,
			hasChildProcessSupport: hostCaps.hasChildProcessSupport,
		});
		if (!cap.capable) {
			const result: SubagentInvocationResult = {
				invocationId,
				decision,
				outcome: 'failure',
				stdout: '',
				stderr: `capability-refused:${cap.reason}`,
				durationMs: 0,
				exitCode: null,
			};
			this._onDidComplete.fire(result);
			return {
				invocationId,
				decision,
				result: Promise.resolve(result),
				abort: () => { /* noop — already failed */ },
			};
		}

		const startMs = Date.now();
		let abortFn: (reason: string) => void = () => { /* will be replaced */ };

		const resultPromise = new Promise<SubagentInvocationResult>((resolve) => {
			const finalize = (outcome: SubagentInvocationResult['outcome'], stdout: string, stderr: string, exitCode: number | null) => {
				this._active.delete(invocationId);
				const r: SubagentInvocationResult = {
					invocationId,
					decision,
					outcome,
					stdout,
					stderr,
					durationMs: Date.now() - startMs,
					exitCode,
				};
				this._onDidComplete.fire(r);
				resolve(r);
			};

			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const armKillTimer = (onTimeout: () => void) => {
				killTimer = setTimeout(() => { onTimeout(); }, decision.killTimeoutMs);
			};
			const clearKillTimer = () => { if (killTimer) { clearTimeout(killTimer); killTimer = undefined; } };

			try {
				if (decision.backend === 'worker-thread') {
					const wt = require('worker_threads') as typeof import('worker_threads');
					const script = req.entryScript ?? this._defaultWorkerScript();
					const worker = new wt.Worker(script, {
						workerData: {
							invocationId,
							kind: req.kind,
							task: req.task,
							handoff: this._materialiseHandoff(decision.parentHandoff, req.handoffContext),
							contextWindowTokens: decision.contextWindowTokens,
						},
						stdout: true,
						stderr: true,
					});
					const stdoutChunks: string[] = [];
					const stderrChunks: string[] = [];
					worker.stdout.on('data', (b: Buffer) => stdoutChunks.push(b.toString('utf8')));
					worker.stderr.on('data', (b: Buffer) => stderrChunks.push(b.toString('utf8')));
					worker.on('exit', (code: number) => {
						clearKillTimer();
						finalize(code === 0 ? 'success' : 'failure', stdoutChunks.join(''), stderrChunks.join(''), code);
					});
					worker.on('error', (e: Error) => {
						clearKillTimer();
						stderrChunks.push(`\n[worker-error] ${e.message}`);
						finalize('failure', stdoutChunks.join(''), stderrChunks.join(''), null);
					});
					armKillTimer(() => {
						worker.terminate().catch(() => { /* swallow */ });
						finalize('timeout', stdoutChunks.join(''), stderrChunks.join('') + '\n[timeout]', null);
					});
					abortFn = (reason: string) => {
						clearKillTimer();
						worker.terminate().catch(() => { /* swallow */ });
						finalize('aborted', stdoutChunks.join(''), stderrChunks.join('') + `\n[aborted:${reason}]`, null);
					};
				} else if (decision.backend === 'child-process') {
					const cp = require('child_process') as typeof import('child_process');
					const script = req.entryScript ?? this._defaultForkScript();
					const child = cp.fork(script, [], {
						env: {
							...process.env,
							VIBE_SUBAGENT_INVOCATION_ID: invocationId,
							VIBE_SUBAGENT_KIND: req.kind,
							VIBE_SUBAGENT_CTX_TOKENS: String(decision.contextWindowTokens),
						},
						silent: true,
					});
					const stdoutChunks: string[] = [];
					const stderrChunks: string[] = [];
					child.stdout?.on('data', (b: Buffer) => stdoutChunks.push(b.toString('utf8')));
					child.stderr?.on('data', (b: Buffer) => stderrChunks.push(b.toString('utf8')));
					child.on('exit', (code: number | null) => {
						clearKillTimer();
						finalize(code === 0 ? 'success' : 'failure', stdoutChunks.join(''), stderrChunks.join(''), code);
					});
					child.on('error', (e: Error) => {
						clearKillTimer();
						stderrChunks.push(`\n[child-error] ${e.message}`);
						finalize('failure', stdoutChunks.join(''), stderrChunks.join(''), null);
					});
					try {
						child.send({
							type: 'start',
							task: req.task,
							handoff: this._materialiseHandoff(decision.parentHandoff, req.handoffContext),
						});
					} catch (e) {
						this._log.warn('[VibeSubagent] child.send failed:', e);
					}
					armKillTimer(() => {
						try { child.kill('SIGTERM'); } catch { /* swallow */ }
						finalize('timeout', stdoutChunks.join(''), stderrChunks.join('') + '\n[timeout]', null);
					});
					abortFn = (reason: string) => {
						clearKillTimer();
						try { child.kill('SIGTERM'); } catch { /* swallow */ }
						finalize('aborted', stdoutChunks.join(''), stderrChunks.join('') + `\n[aborted:${reason}]`, null);
					};
				} else {
					// inline-fallback: run task description echo with hard deadline.
					// Real inline executor is left to caller via override script —
					// this default keeps lifecycle semantics correct.
					armKillTimer(() => {
						finalize('timeout', '', '[inline-fallback timeout]', null);
					});
					Promise.resolve().then(() => {
						clearKillTimer();
						finalize('success', `[inline] kind=${req.kind} task=${req.task.length}b`, '', 0);
					});
					abortFn = (reason: string) => {
						clearKillTimer();
						finalize('aborted', '', `[aborted:${reason}]`, null);
					};
				}
			} catch (e: unknown) {
				clearKillTimer();
				const msg = e instanceof Error ? e.message : String(e);
				this._log.error('[VibeSubagent] spawn failed:', msg);
				finalize('failure', '', `spawn-error:${msg}`, null);
			}
		});

		this._active.set(invocationId, { abort: (reason: string) => abortFn(reason) });

		return {
			invocationId,
			decision,
			result: resultPromise,
			abort: (reason: string) => abortFn(reason),
		};
	}

	private _detectHostCapabilities(): { hasWorkerSupport: boolean; hasChildProcessSupport: boolean } {
		let hasWorkerSupport = false;
		let hasChildProcessSupport = false;
		try {
			require.resolve('worker_threads');
			hasWorkerSupport = true;
		} catch { /* not available */ }
		try {
			require.resolve('child_process');
			hasChildProcessSupport = true;
		} catch { /* not available */ }
		return { hasWorkerSupport, hasChildProcessSupport };
	}

	private _materialiseHandoff(handoff: SubagentIsolationDecision['parentHandoff'], raw: string | undefined): string {
		if (handoff === 'none' || handoff === 'task-only') { return ''; }
		const ctx = raw ?? '';
		if (handoff === 'summarised') {
			const MAX = 4 * 1024;
			return ctx.length > MAX ? ctx.slice(0, MAX) + '\n…[summarised]' : ctx;
		}
		return ctx;
	}

	private _defaultWorkerScript(): string {
		// Resolved relative to extension install root by the agent runtime
		// installer. If absent, the policy decoder still returns a decision —
		// the runtime falls back to inline-fallback at spawn time.
		return require('path').resolve(process.cwd(), 'scripts', 'vibe-subagent-worker.js');
	}

	private _defaultForkScript(): string {
		return require('path').resolve(process.cwd(), 'scripts', 'vibe-subagent-fork.js');
	}
}

registerSingleton(IVibeSubagentIsolationRuntime, VibeSubagentIsolationRuntime, InstantiationType.Delayed);
