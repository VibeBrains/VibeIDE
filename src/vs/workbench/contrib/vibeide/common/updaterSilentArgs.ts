/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Updater silent-installer args decoder + lifecycle FSM (pure helper)
 * (roadmap §"Автообновление — Отдельный updater (или вспомогательный
 * процесс): аргументы `--wait-pid`, silent-инсталлятор, автозапуск после
 * успеха; таймауты и лог").
 *
 * Pure helpers — `vscode`-free. The actual fork/spawn of the helper +
 * code-signing requirement (see roadmap line 952) live in the runtime
 * adapter; this module is the contract.
 *
 * Skeleton-acceptable note: silent installer without an EV cert on Windows
 * triggers SmartScreen on every upgrade. Roadmap line 952 explicitly groups
 * this with code signing as a "Distribution readiness gate" — the helpers
 * here ship the args contract today; cert + helper binary are Phase 1
 * distribution work.
 */

import { ProjectCommandLaunchOS } from './projectCommandsTerminalPolicy.js';

const MAX_LOG_PATH_LEN = 4096;

export interface UpdaterArgs {
	readonly waitPid: number;
	readonly installerPath: string;
	readonly silent: boolean;
	readonly autoLaunch: boolean;
	readonly logPath?: string;
	readonly timeoutSeconds?: number;
	readonly os: ProjectCommandLaunchOS;
}

export type DecodeResult<T> =
	| { readonly ok: true; readonly value: T }
	| { readonly ok: false; readonly reason: string };

/**
 * Decode CLI args passed to the updater helper. Pure — caller passes argv
 * already split and the OS detection. Refuses any malformation; never
 * throws.
 *
 *   --wait-pid <int>           required, must be a positive integer
 *   --installer <abs-path>     required, must be a non-empty string
 *   --silent                   optional flag (default false)
 *   --auto-launch              optional flag (default true)
 *   --no-auto-launch           optional flag (overrides --auto-launch)
 *   --log <path>               optional, ≤ 4096 chars
 *   --timeout-seconds <int>    optional, 1..3600
 */
export function decodeUpdaterArgs(argv: ReadonlyArray<string>, os: ProjectCommandLaunchOS): DecodeResult<UpdaterArgs> {
	let waitPid: number | undefined;
	let installerPath: string | undefined;
	let silent = false;
	let autoLaunch = true;
	let logPath: string | undefined;
	let timeoutSeconds: number | undefined;

	for (let i = 0; i < argv.length; i++) {
		const tok = argv[i];
		switch (tok) {
			case '--wait-pid': {
				const v = argv[++i];
				if (v === undefined) { return { ok: false, reason: 'wait-pid-missing-value' }; }
				const n = Number(v);
				if (!Number.isInteger(n) || n <= 0) { return { ok: false, reason: 'wait-pid-invalid' }; }
				waitPid = n;
				break;
			}
			case '--installer': {
				const v = argv[++i];
				if (v === undefined || v.length === 0) { return { ok: false, reason: 'installer-missing-value' }; }
				installerPath = v;
				break;
			}
			case '--silent':
				silent = true;
				break;
			case '--auto-launch':
				autoLaunch = true;
				break;
			case '--no-auto-launch':
				autoLaunch = false;
				break;
			case '--log': {
				const v = argv[++i];
				if (v === undefined || v.length === 0) { return { ok: false, reason: 'log-missing-value' }; }
				if (v.length > MAX_LOG_PATH_LEN) { return { ok: false, reason: 'log-too-long' }; }
				logPath = v;
				break;
			}
			case '--timeout-seconds': {
				const v = argv[++i];
				if (v === undefined) { return { ok: false, reason: 'timeout-missing-value' }; }
				const n = Number(v);
				if (!Number.isInteger(n) || n < 1 || n > 3600) { return { ok: false, reason: 'timeout-out-of-range' }; }
				timeoutSeconds = n;
				break;
			}
			default:
				return { ok: false, reason: `unknown-flag:${tok}` };
		}
	}

	if (waitPid === undefined) { return { ok: false, reason: 'wait-pid-required' }; }
	if (installerPath === undefined) { return { ok: false, reason: 'installer-required' }; }

	return {
		ok: true,
		value: {
			waitPid,
			installerPath,
			silent,
			autoLaunch,
			...(logPath !== undefined ? { logPath } : {}),
			...(timeoutSeconds !== undefined ? { timeoutSeconds } : {}),
			os,
		},
	};
}

// -----------------------------------------------------------------------------
// Per-OS silent-installer command spec
// -----------------------------------------------------------------------------

export interface SilentInstallerSpec {
	readonly command: string;
	readonly args: readonly string[];
	readonly suggestsCodeSigningGate: boolean;
}

/**
 * Build the silent-install command for the resolved updater args. Pure.
 *
 *   - Windows NSIS: `<installer> /S /D=<install dir>` (no /D supplied here —
 *     caller composes after picking the install root).
 *   - macOS .pkg: `installer -pkg <installer> -target /` — requires sudo at
 *     runtime; helper just emits the spec.
 *   - Linux .deb: `dpkg -i <installer>` — sudo runtime requirement.
 *   - Linux .rpm: `rpm -U <installer>`.
 *   - Linux AppImage: spawn directly; no install required.
 *
 * The `suggestsCodeSigningGate` flag is true when the OS will enforce
 * UAC / SmartScreen / Gatekeeper without a signed helper. Caller surfaces
 * a banner: "this upgrade will prompt for credentials".
 */
export function buildSilentInstallerSpec(args: UpdaterArgs): SilentInstallerSpec {
	switch (args.os) {
		case 'win32':
			return {
				command: args.installerPath,
				args: args.silent ? ['/S'] : [],
				suggestsCodeSigningGate: true,
			};
		case 'darwin':
			if (/\.pkg$/i.test(args.installerPath)) {
				return {
					command: 'installer',
					args: ['-pkg', args.installerPath, '-target', '/'],
					suggestsCodeSigningGate: true,
				};
			}
			return {
				command: 'open',
				args: ['-W', '-a', args.installerPath],
				suggestsCodeSigningGate: true,
			};
		case 'linux':
			if (/\.deb$/i.test(args.installerPath)) {
				return { command: 'dpkg', args: ['-i', args.installerPath], suggestsCodeSigningGate: false };
			}
			if (/\.rpm$/i.test(args.installerPath)) {
				return { command: 'rpm', args: ['-U', args.installerPath], suggestsCodeSigningGate: false };
			}
			if (/\.appimage$/i.test(args.installerPath)) {
				return { command: args.installerPath, args: [], suggestsCodeSigningGate: false };
			}
			return { command: args.installerPath, args: [], suggestsCodeSigningGate: false };
		case 'unknown':
		default:
			return { command: args.installerPath, args: [], suggestsCodeSigningGate: false };
	}
}

// -----------------------------------------------------------------------------
// Lifecycle FSM (idle → wait-pid → install → autolaunch → done)
// -----------------------------------------------------------------------------

export type UpdaterState =
	| { readonly kind: 'idle' }
	| { readonly kind: 'waiting-pid'; readonly pid: number; readonly waitStartedAtMs: number }
	| { readonly kind: 'installing'; readonly startedAtMs: number }
	| { readonly kind: 'launching'; readonly installEndedAtMs: number }
	| { readonly kind: 'done'; readonly endedAtMs: number; readonly outcome: 'success' | 'install-failed' | 'launch-failed' | 'timeout' | 'aborted' };

export type UpdaterEvent =
	| { readonly kind: 'start'; readonly nowMs: number }
	| { readonly kind: 'pid-released'; readonly nowMs: number }
	| { readonly kind: 'install-completed'; readonly nowMs: number }
	| { readonly kind: 'install-failed'; readonly nowMs: number }
	| { readonly kind: 'launch-completed'; readonly nowMs: number }
	| { readonly kind: 'launch-failed'; readonly nowMs: number }
	| { readonly kind: 'timeout'; readonly nowMs: number }
	| { readonly kind: 'abort'; readonly nowMs: number };

export type UpdaterTransition =
	| { readonly ok: true; readonly next: UpdaterState }
	| { readonly ok: false; readonly reason: string };

export function transitionUpdater(state: UpdaterState, event: UpdaterEvent, args?: Pick<UpdaterArgs, 'autoLaunch' | 'waitPid'>): UpdaterTransition {
	if (event.kind === 'abort') {
		if (state.kind === 'done') { return { ok: false, reason: 'done-is-terminal' }; }
		return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'aborted' } };
	}
	if (event.kind === 'timeout') {
		if (state.kind === 'done' || state.kind === 'idle') { return { ok: false, reason: 'timeout-from-non-running' }; }
		return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'timeout' } };
	}
	switch (state.kind) {
		case 'idle':
			if (event.kind === 'start') {
				return { ok: true, next: { kind: 'waiting-pid', pid: args?.waitPid ?? -1, waitStartedAtMs: event.nowMs } };
			}
			return { ok: false, reason: `idle-rejects:${event.kind}` };
		case 'waiting-pid':
			if (event.kind === 'pid-released') {
				return { ok: true, next: { kind: 'installing', startedAtMs: event.nowMs } };
			}
			return { ok: false, reason: `waiting-pid-rejects:${event.kind}` };
		case 'installing':
			if (event.kind === 'install-completed') {
				if (args?.autoLaunch === false) {
					return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'success' } };
				}
				return { ok: true, next: { kind: 'launching', installEndedAtMs: event.nowMs } };
			}
			if (event.kind === 'install-failed') {
				return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'install-failed' } };
			}
			return { ok: false, reason: `installing-rejects:${event.kind}` };
		case 'launching':
			if (event.kind === 'launch-completed') {
				return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'success' } };
			}
			if (event.kind === 'launch-failed') {
				return { ok: true, next: { kind: 'done', endedAtMs: event.nowMs, outcome: 'launch-failed' } };
			}
			return { ok: false, reason: `launching-rejects:${event.kind}` };
		case 'done':
			return { ok: false, reason: 'done-is-terminal' };
	}
}
