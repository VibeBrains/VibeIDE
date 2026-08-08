/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { VibeHookEvent, VibeHookConfig } from './hookConfig.js';
import { VibeHookDecision } from './hookOutcome.js';

export const VIBE_HOOKS_CHANNEL = 'vibeide-channel-hooks';

/** Configuration keys of project hooks. */
export const VibeHooksConfigKeys = {
	section: 'vibeide.hooks',
	enabled: 'vibeide.hooks.enabled',
} as const;

/** What a hook reads from stdin. Stable shape: hooks are user scripts, not our code. */
export interface VibeHookPayload {
	readonly event: VibeHookEvent;
	/** Tool being called, absent for `turnEnd`. */
	readonly tool?: string;
	/** Raw tool parameters as the model produced them. */
	readonly params?: { readonly [name: string]: unknown };
	/** Absolute path of the workspace folder the hook runs in. */
	readonly cwd: string;
	/** Files changed during the turn — only for `turnEnd`. */
	readonly changedFiles?: readonly string[];
}

export interface VibeHookRunRequest {
	readonly command: string;
	readonly cwd: string;
	readonly timeoutMs: number;
	readonly event: VibeHookEvent;
	readonly toolName: string | undefined;
	readonly payload: VibeHookPayload;
}

export interface VibeHookProcessResult {
	/** `undefined` when the process never started or was killed on timeout. */
	readonly exitCode: number | undefined;
	readonly stdout: string;
	readonly stderr: string;
	readonly timedOut: boolean;
	readonly durationMs: number;
}

/** Main-process side: spawning is not available in a window. */
export interface IVibeHooksMain {
	runHook(request: VibeHookRunRequest): Promise<VibeHookProcessResult>;
}

export const IVibeHooksService = createDecorator<IVibeHooksService>('vibeHooksService');

/**
 * Window-side facade over project hooks. Declared here rather than next to its implementation so
 * the chat loop (`browser/`) can depend on it without reaching into the electron layer.
 */
export interface IVibeHooksService {
	readonly _serviceBrand: undefined;
	/**
	 * Runs the hooks attached to this moment and folds them into one decision.
	 * Never throws: a failure inside the hook machinery must not take the turn down with it.
	 */
	run(event: VibeHookEvent, context: { toolName?: string; params?: { [name: string]: unknown }; changedFiles?: readonly string[] }): Promise<VibeHookDecision>;
	/** Hooks declared by the project right now, for the settings panel and the doctor. */
	readConfig(): Promise<VibeHookConfig>;
}
