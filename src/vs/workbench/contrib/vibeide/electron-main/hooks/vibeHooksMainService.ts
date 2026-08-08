/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { spawn } from 'child_process';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { isWindows } from '../../../../../base/common/platform.js';
import { vibeLog } from '../../common/vibeLog.js';
import { IVibeHooksMain, VibeHookProcessResult, VibeHookRunRequest } from '../../common/hooks/vibeHookTypes.js';

/**
 * Runs project hooks as real processes.
 *
 * Lives in the main process, not in a window: a hook is an ordinary child process with a working
 * directory, an environment, stdin and an exit code, and the renderer has none of those. Going
 * through the terminal service instead would lose the two things the contract is built on —
 * the payload on stdin and the exit code.
 */
export class VibeHooksMainService extends Disposable implements IVibeHooksMain {

	async runHook(request: VibeHookRunRequest): Promise<VibeHookProcessResult> {
		const startedAt = Date.now();
		return new Promise<VibeHookProcessResult>(resolve => {
			// Through a shell on purpose: hooks are written as command lines (`npm run lint`,
			// `node .vibe/hooks/x.js`), and asking authors to pre-split argv would make the
			// simplest hook the hardest to write.
			const shell = isWindows ? (process.env['COMSPEC'] || 'cmd.exe') : '/bin/sh';
			const args = isWindows ? ['/d', '/s', '/c', request.command] : ['-c', request.command];

			let child;
			try {
				child = spawn(shell, args, {
					cwd: request.cwd,
					env: { ...process.env, VIBE_HOOK_EVENT: request.event, VIBE_HOOK_TOOL: request.toolName ?? '' },
					windowsVerbatimArguments: isWindows,
				});
			} catch (e) {
				resolve({ exitCode: undefined, stdout: '', stderr: `${(e as Error).message}`, timedOut: false, durationMs: Date.now() - startedAt });
				return;
			}

			let stdout = '';
			let stderr = '';
			let settled = false;
			const finish = (result: VibeHookProcessResult) => {
				if (settled) { return; }
				settled = true;
				clearTimeout(timer);
				resolve(result);
			};

			const timer = setTimeout(() => {
				// SIGKILL rather than SIGTERM: a hook that ignored its deadline has already proven
				// it will not stop politely, and the agent is waiting on it.
				try { child.kill('SIGKILL'); } catch { /* already gone */ }
				vibeLog.warn('Hooks', `hook timed out after ${request.timeoutMs}ms: ${request.command}`);
				finish({ exitCode: undefined, stdout, stderr, timedOut: true, durationMs: Date.now() - startedAt });
			}, request.timeoutMs);

			child.stdout?.on('data', chunk => { stdout += String(chunk); });
			child.stderr?.on('data', chunk => { stderr += String(chunk); });
			child.on('error', e => finish({ exitCode: undefined, stdout, stderr: stderr || e.message, timedOut: false, durationMs: Date.now() - startedAt }));
			child.on('close', code => {
				vibeLog.info('Hooks', `hook «${request.command}» exited ${code} in ${Date.now() - startedAt}ms`);
				finish({ exitCode: code ?? undefined, stdout, stderr, timedOut: false, durationMs: Date.now() - startedAt });
			});

			// The payload goes in on stdin, not as an argument: tool parameters routinely contain
			// quotes, newlines and whole file contents, and a command line would mangle them.
			try {
				child.stdin?.end(JSON.stringify(request.payload));
			} catch {
				// A hook that closed stdin immediately is legal; its exit code still decides.
			}
		});
	}
}
