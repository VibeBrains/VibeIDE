/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { scheduleAtNextAnimationFrame } from '../../../../base/browser/dom.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { removeAnsiEscapeCodes } from '../../../../base/common/strings.js';
import { ITerminalCapabilityImplMap, TerminalCapability } from '../../../../platform/terminal/common/capabilities/capabilities.js';
import { URI } from '../../../../base/common/uri.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { TerminalLocation, IShellLaunchConfig } from '../../../../platform/terminal/common/terminal.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ITerminalService, ITerminalInstance, ICreateTerminalOptions } from '../../../../workbench/contrib/terminal/browser/terminal.js';
import { MAX_TERMINAL_BG_COMMAND_TIME, MAX_TERMINAL_CHARS, MAX_TERMINAL_INACTIVE_TIME } from '../common/prompt/prompts.js';
import { TerminalResolveReason } from '../common/toolsServiceTypes.js';
import { timeout } from '../../../../base/common/async.js';
import { truncateHeadTail } from '../common/toolHardening.js';
import { condenseTerminalOutput } from '../common/terminalOutputCondenser.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { generateUuid } from '../../../../base/common/uuid.js';



export interface ITerminalToolService {
	readonly _serviceBrand: undefined;

	listPersistentTerminalIds(): string[];
	runCommand(command: string, opts:
		| { type: 'persistent'; persistentTerminalId: string; timeoutMs?: number }
		| { type: 'temporary'; cwd: string | null; terminalId: string; timeoutMs?: number }
		// | { type: 'apply', terminalId: string }
	): Promise<{ interrupt: () => void; resPromise: Promise<{ result: string; resolveReason: TerminalResolveReason }> }>;

	focusPersistentTerminal(terminalId: string): Promise<void>;
	persistentTerminalExists(terminalId: string): boolean;

	readTerminal(terminalId: string): Promise<string>;

	createPersistentTerminal(opts: { cwd: string | null }): Promise<string>;
	killPersistentTerminal(terminalId: string): Promise<void>;

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined;
	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined;
}
export const ITerminalToolService = createDecorator<ITerminalToolService>('TerminalToolService');

/**
 * Narrows the terminal config union to the {@link IShellLaunchConfig} variant, which is the
 * only member that carries an optional `name`. The two profile variants are distinguished by
 * their required `profileName` / `extensionIdentifier` discriminators.
 */
function isShellLaunchConfigWithName(config: ICreateTerminalOptions['config']): config is IShellLaunchConfig {
	return !!config && !Object.hasOwn(config, 'profileName') && !Object.hasOwn(config, 'extensionIdentifier');
}



// function isCommandComplete(output: string) {
// 	// https://code.visualstudio.com/docs/terminal/shell-integration#_vs-code-custom-sequences-osc-633-st
// 	const completionMatch = output.match(/\]633;D(?:;(\d+))?/)
// 	if (!completionMatch) { return false }
// 	if (completionMatch[1] !== undefined) return { exitCode: parseInt(completionMatch[1]) }
// 	return { exitCode: 0 }
// }


/** Base label for persistent agent terminals (shown in Terminal panel tabs). */
const PERSISTENT_AGENT_TERMINAL_LABEL = 'VibeIDE Agent';
/** Prior shell still used this agent terminal tab title; accepted for session restore. */
const LEGACY_AGENT_PREFIX = String.fromCharCode(67, 111, 114, 116, 101, 120);
const LEGACY_PERSISTENT_AGENT_TERMINAL_LABEL = `${LEGACY_AGENT_PREFIX} Agent`;
const LEGACY_AGENT_TAB_RE = new RegExp(`^${LEGACY_AGENT_PREFIX} Agent \\((\\d+)\\)$`, 'u');

export const persistentTerminalNameOfId = (id: string) => {
	if (id === '1') {
		return PERSISTENT_AGENT_TERMINAL_LABEL;
	}
	return `${PERSISTENT_AGENT_TERMINAL_LABEL} (${id})`;
};
export const idOfPersistentTerminalName = (name: string) => {
	if (name === PERSISTENT_AGENT_TERMINAL_LABEL || name === LEGACY_PERSISTENT_AGENT_TERMINAL_LABEL) {
		return '1';
	}
	const matchNew = name.match(/^VibeIDE Agent \((\d+)\)$/u);
	const matchLegacy = name.match(LEGACY_AGENT_TAB_RE);
	const match = matchNew ?? matchLegacy;
	if (!match) {
		return null;
	}
	const n = parseInt(match[1], 10);
	if (!Number.isFinite(n) || n < 1) {
		return null;
	}
	return String(n);
};

export class TerminalToolService extends Disposable implements ITerminalToolService {
	readonly _serviceBrand: undefined;

	private persistentTerminalInstanceOfId: Record<string, ITerminalInstance> = {};
	private temporaryTerminalInstanceOfId: Record<string, ITerminalInstance> = {};

	constructor(
		@ITerminalService private readonly terminalService: ITerminalService,
		@IWorkspaceContextService private readonly workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly configurationService: IConfigurationService,
	) {
		super();

		// runs on ALL terminals for simplicity
		const initializeTerminal = (terminal: ITerminalInstance) => {
			// when exit, remove
			const d = terminal.onExit(() => {
				const terminalId = idOfPersistentTerminalName(terminal.title);
				if (terminalId !== null && Object.hasOwn(this.persistentTerminalInstanceOfId, terminalId)) { delete this.persistentTerminalInstanceOfId[terminalId]; }
				d.dispose();
			});
		};


		// initialize any terminals that are already open
		for (const terminal of terminalService.instances) {
			const proposedTerminalId = idOfPersistentTerminalName(terminal.title);
			if (proposedTerminalId) { this.persistentTerminalInstanceOfId[proposedTerminalId] = terminal; }

			initializeTerminal(terminal);
		}

		this._register(
			terminalService.onDidCreateInstance(terminal => { initializeTerminal(terminal); })
		);

	}

	// Max chars of terminal output injected into the model's context, per read/run. `vibeide.tools.*`
	// with the prompts.ts constant as default + defensive clamp. Caps token cost of noisy commands;
	// the semantic condenser runs BEFORE this hard cap (see condenseTerminalOutput).
	private maxTerminalOutputChars(): number {
		return Math.max(1_000, Math.min(5_000_000, this.configurationService.getValue<number>('vibeide.tools.maxTerminalOutputChars') ?? MAX_TERMINAL_CHARS));
	}


	listPersistentTerminalIds() {
		return Object.keys(this.persistentTerminalInstanceOfId);
	}

	getValidNewTerminalId(): string {
		// {1 2 3} # size 3, new=4
		// {1 3 4} # size 3, new=2
		// 1 <= newTerminalId <= n + 1
		const n = Object.keys(this.persistentTerminalInstanceOfId).length;
		if (n === 0) { return '1'; }

		for (let i = 1; i <= n + 1; i++) {
			const potentialId = i + '';
			if (!Object.hasOwn(this.persistentTerminalInstanceOfId, potentialId)) { return potentialId; }
		}
		throw new Error('This should never be reached by pigeonhole principle');
	}


	private async _createTerminal(props: { cwd: string | null; config: ICreateTerminalOptions['config']; hidden?: boolean }) {
		const { cwd: override_cwd, config, hidden } = props;

		const cwd: URI | string | undefined =
			override_cwd !== null && override_cwd !== undefined
				? override_cwd
				: this.workspaceContextService.getWorkspace().folders[0]?.uri;

		const options: ICreateTerminalOptions = {
			cwd,
			location: hidden ? undefined : TerminalLocation.Panel,
			config: {
				name: isShellLaunchConfigWithName(config) ? config.name : undefined,
				forceShellIntegration: true,
				hideFromUser: hidden ? true : undefined,
				// Copy any other properties from the provided config
				...config,
			},
			// Skip profile check to ensure the terminal is created quickly
			skipContributedProfileCheck: true,
		};

		const terminal = await this.terminalService.createTerminal(options);

		// // when a new terminal is created, there is an initial command that gets run which is empty, wait for it to end before returning
		// const disposables: IDisposable[] = []
		// const waitForMount = new Promise<void>(res => {
		// 	let data = ''
		// 	const d = terminal.onData(newData => {
		// 		data += newData
		// 		if (isCommandComplete(data)) { res() }
		// 	})
		// 	disposables.push(d)
		// })
		// const waitForTimeout = new Promise<void>(res => { setTimeout(() => { res() }, 5000) })

		// await Promise.any([waitForMount, waitForTimeout,])
		// disposables.forEach(d => d.dispose())

		return terminal;

	}

	createPersistentTerminal: ITerminalToolService['createPersistentTerminal'] = async ({ cwd }) => {
		const terminalId = this.getValidNewTerminalId();
		const config = { name: persistentTerminalNameOfId(terminalId), title: persistentTerminalNameOfId(terminalId) };
		const terminal = await this._createTerminal({ cwd, config, });
		this.persistentTerminalInstanceOfId[terminalId] = terminal;
		return terminalId;
	};

	async killPersistentTerminal(terminalId: string) {
		const terminal = this.persistentTerminalInstanceOfId[terminalId];
		if (!terminal) { throw new Error(`Kill Terminal: Terminal with ID ${terminalId} did not exist.`); }
		terminal.dispose();
		delete this.persistentTerminalInstanceOfId[terminalId];
		return;
	}

	persistentTerminalExists(terminalId: string): boolean {
		return Object.hasOwn(this.persistentTerminalInstanceOfId, terminalId);
	}


	getTemporaryTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) { return; }
		const terminal = this.temporaryTerminalInstanceOfId[terminalId];
		if (!terminal) { return; } // should never happen
		return terminal;
	}

	getPersistentTerminal(terminalId: string): ITerminalInstance | undefined {
		if (!terminalId) { return; }
		const terminal = this.persistentTerminalInstanceOfId[terminalId];
		if (!terminal) { return; } // should never happen
		return terminal;
	}


	focusPersistentTerminal: ITerminalToolService['focusPersistentTerminal'] = async (terminalId) => {
		if (!terminalId) { return; }
		const terminal = this.persistentTerminalInstanceOfId[terminalId];
		if (!terminal) { return; } // should never happen
		this.terminalService.setActiveInstance(terminal);
		await this.terminalService.focusActiveInstance();
	};




	readTerminal: ITerminalToolService['readTerminal'] = async (terminalId) => {
		// Try persistent first, then temporary
		const terminal = this.getPersistentTerminal(terminalId) ?? this.getTemporaryTerminal(terminalId);
		if (!terminal) {
			throw new Error(`Read Terminal: Terminal with ID ${terminalId} does not exist.`);
		}

		// Ensure the xterm.js instance has been created – otherwise we cannot access the buffer.
		if (!terminal.xterm) {
			throw new Error('Read Terminal: The requested terminal has not yet been rendered and therefore has no scrollback buffer available.');
		}

		// Collect lines from the buffer iterator (oldest to newest)
		const lines: string[] = [];
		for (const line of terminal.xterm.getBufferReverseIterator()) {
			lines.unshift(line);
		}

		const result = truncateHeadTail(removeAnsiEscapeCodes(lines.join('\n')), this.maxTerminalOutputChars());
		return result;
	};

	private async _waitForCommandDetectionCapability(terminal: ITerminalInstance) {
		const cmdCap = terminal.capabilities.get(TerminalCapability.CommandDetection);
		if (cmdCap) { return cmdCap; }

		const disposables: IDisposable[] = [];

		const waitTimeout = timeout(2_000);
		const waitForCapability = new Promise<ITerminalCapabilityImplMap[TerminalCapability.CommandDetection]>((res) => {
			disposables.push(
				terminal.capabilities.onDidAddCapability((e) => {
					if (e.id === TerminalCapability.CommandDetection) { res(e.capability); }
				})
			);
		});

		const capability = await Promise.any([waitTimeout, waitForCapability])
			.finally(() => { disposables.forEach((d) => d.dispose()); });

		return capability ?? undefined;
	}

	runCommand: ITerminalToolService['runCommand'] = async (command, params) => {
		await this.terminalService.whenConnected;

		const { type } = params;
		const isPersistent = type === 'persistent';

		let terminal: ITerminalInstance;
		const disposables: IDisposable[] = [];

		if (isPersistent) { // BG process
			const { persistentTerminalId } = params;
			terminal = this.persistentTerminalInstanceOfId[persistentTerminalId];
			if (!terminal) { throw new Error(`Unexpected internal error: Terminal with ID ${persistentTerminalId} did not exist.`); }
		}
		else {
			const { cwd } = params;
			terminal = await this._createTerminal({ cwd: cwd, config: undefined, hidden: true });
			this.temporaryTerminalInstanceOfId[params.terminalId] = terminal;
		}

		const interrupt = () => {
			// Drop from the map synchronously so callers see the terminal gone immediately,
			// but defer the actual dispose by one animation frame: xterm may have in-flight
			// rAFs from decorationAddon / resize that crash with "Cannot read properties of
			// undefined (reading 'dimensions')" if the renderer is torn down before they fire.
			if (!isPersistent) { delete this.temporaryTerminalInstanceOfId[params.terminalId]; }
			else { delete this.persistentTerminalInstanceOfId[params.persistentTerminalId]; }
			scheduleAtNextAnimationFrame(mainWindow, () => {
				try {
					terminal.dispose();
				} catch {
					// terminal may already be disposed externally — ignore
				}
			});
		};

		const waitForResult = async () => {
			if (isPersistent) {
				// focus the terminal about to run
				this.terminalService.setActiveInstance(terminal);
				await this.terminalService.focusActiveInstance();
			}
			let result: string = '';
			let resolveReason: TerminalResolveReason | undefined;


			const cmdCap = await this._waitForCommandDetectionCapability(terminal);
			// if (!cmdCap) throw new Error(`There was an error using the terminal: CommandDetection capability did not mount yet. Please try again in a few seconds or report this to the Void team.`)

			// Prefer the structured command-detection capability when available

			const waitUntilDone = new Promise<void>(resolve => {
				if (!cmdCap) { return; }
				const l = cmdCap.onCommandFinished(cmd => {
					if (resolveReason) { return; } // already resolved
					resolveReason = { type: 'done', exitCode: cmd.exitCode ?? 0 };
					result = cmd.getOutput() ?? '';
					l.dispose();
					resolve();
				});
				disposables.push(l);
			});


			// Shell-integration-independent completion signal. CommandDetection (and thus
			// `onCommandFinished`) silently never mounts when PowerShell's ExecutionPolicy blocks the
			// integration script — common in locked-down corp shells — so EVERY foreground command would
			// otherwise block until the inactivity timeout (~8s) on top of the capability wait. We echo a
			// unique marker + `$?` after the command (PowerShell → True/False, POSIX → exit code) and
			// resolve the instant it shows up in `onData`. The marker is UUID-based so it can't collide
			// with real output, and the regex requires True/False/digits so it never matches the literal
			// `$?` in the echoed command line itself.
			const marker = `VIBEDONE${generateUuid().replace(/-/g, '')}`;
			const useSentinel = !isPersistent;
			const waitUntilSentinel = new Promise<void>(resolve => {
				if (!useSentinel) { return; }
				let buf = '';
				const re = new RegExp(`${marker}:(True|False|-?\\d+)`);
				const d = terminal.onData(chunk => {
					if (resolveReason) { return; }
					buf += chunk;
					const m = re.exec(buf);
					if (!m) { return; }
					const tok = m[1];
					const code = tok === 'True' ? 0 : tok === 'False' ? 1 : parseInt(tok, 10);
					resolveReason = { type: 'done', exitCode: Number.isFinite(code) ? code : 0 };
					d.dispose();
					resolve();
				});
				disposables.push(d);
			});

			// send the command now that listeners are attached
			await terminal.sendText(command, true);
			// Queue the marker echo right after; the shell runs it once the command returns.
			if (useSentinel) {
				await terminal.sendText(`echo "${marker}:$?"`, true);
			}

			// Caller-supplied timeout takes precedence over the hard-coded inactivity / bg limits.
			// timeoutMs interpretation:
			//   - persistent terminals: wall-clock cap before returning partial output (default = MAX_TERMINAL_BG_COMMAND_TIME * 1000)
			//   - temporary terminals: inactivity cap (default = MAX_TERMINAL_INACTIVE_TIME * 1000)
			const overrideTimeoutMs = params.timeoutMs && params.timeoutMs > 0 ? params.timeoutMs : null;
			const waitUntilInterrupt = isPersistent ?
				new Promise<void>((res) => {
					setTimeout(() => {
						resolveReason = { type: 'timeout' };
						res();
					}, overrideTimeoutMs ?? MAX_TERMINAL_BG_COMMAND_TIME * 1000);
				})
				// inactivity-based timeout
				: new Promise<void>(res => {
					let globalTimeoutId: ReturnType<typeof setTimeout>;
					const inactivityMs = overrideTimeoutMs ?? MAX_TERMINAL_INACTIVE_TIME * 1000;
					const resetTimer = () => {
						clearTimeout(globalTimeoutId);
						globalTimeoutId = setTimeout(() => {
							if (resolveReason) { return; }

							resolveReason = { type: 'timeout' };
							res();
						}, inactivityMs);
					};

					const dTimeout = terminal.onData(() => { resetTimer(); });
					disposables.push(dTimeout, toDisposable(() => clearTimeout(globalTimeoutId)));
					resetTimer();
				});

			// wait for result
			await Promise.any([waitUntilDone, waitUntilSentinel, waitUntilInterrupt])
				.finally(() => disposables.forEach(d => d.dispose()));



			// read result if timed out OR resolved via the sentinel (the structured `getOutput()` wasn't
			// captured), then strip the marker echo + marker output line from the raw terminal text.
			if (resolveReason?.type === 'timeout' || (resolveReason?.type === 'done' && !result)) {
				const terminalId = isPersistent ? params.persistentTerminalId : params.terminalId;
				result = await this.readTerminal(terminalId);
			}
			if (useSentinel && result) {
				result = result.split('\n').filter(line => !line.includes(marker)).join('\n');
			}

			if (!isPersistent) {
				interrupt();
			}

			if (!resolveReason) { throw new Error('Unexpected internal error: Promise.any should have resolved with a reason.'); }

			if (!isPersistent) { result = `$ ${command}\n${result}`; }
			// Semantic condense (token-economy B) BEFORE the size clamp: collapse test-runner
			// "ok"-spam, progress bars and duplicate lines; errors/summaries stay verbatim.
			// The char clamp below remains the safety net for unrecognised huge output.
			result = removeAnsiEscapeCodes(result);
			if (this.configurationService.getValue<boolean>('vibeide.terminal.condenseOutput') !== false) {
				result = condenseTerminalOutput(result);
			}
			result = truncateHeadTail(result, this.maxTerminalOutputChars());
			return { result, resolveReason };

		};
		const resPromise = waitForResult();

		return {
			interrupt,
			resPromise,
		};
	};


}

registerSingleton(ITerminalToolService, TerminalToolService, InstantiationType.Delayed);
