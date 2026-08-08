/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { IWorkspaceTrustManagementService } from '../../../../../platform/workspace/common/workspaceTrust.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { localize } from '../../../../../nls.js';
import { vibeLog } from '../../common/vibeLog.js';
import { hooksFor, parseHookConfig, VibeHookConfig, VibeHookEvent } from '../../common/hooks/hookConfig.js';
import { decideHooks, VibeHookDecision, verdictOf } from '../../common/hooks/hookOutcome.js';
import { IVibeHooksMain, IVibeHooksService, VIBE_HOOKS_CHANNEL, VibeHookPayload, VibeHooksConfigKeys } from '../../common/hooks/vibeHookTypes.js';

const HOOKS_FILE = ['.vibe', 'hooks.json'];

const NOTHING: VibeHookDecision = { blocked: false, agentMessage: undefined, brokenHooks: [] };

/**
 * Project hooks: deterministic commands around the agent loop.
 *
 * Three conditions must all hold before a single hook runs, and each covers a different way this
 * could hurt someone:
 *
 * - **the setting is on** — cloning a repository must never be enough to execute its code;
 * - **the workspace is trusted** — the same guarantee VS Code already gives for tasks and
 *   debuggers, reused rather than invented;
 * - **the file parses** — a half-understood hook is not run at all.
 */
class VibeHooksService extends Disposable implements IVibeHooksService {
	readonly _serviceBrand: undefined;

	private readonly _main: IVibeHooksMain;
	/** Cached config; dropped whenever the file changes. */
	private _cached: Promise<VibeHookConfig> | undefined;
	/** Problems already told to the user — a broken hook must not nag on every tool call. */
	private readonly _reported = new Set<string>();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@IFileService private readonly _files: IFileService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@INotificationService private readonly _notifications: INotificationService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IWorkspaceTrustManagementService private readonly _trust: IWorkspaceTrustManagementService,
	) {
		super();
		this._main = ProxyChannel.toService<IVibeHooksMain>(mainProcessService.getChannel(VIBE_HOOKS_CHANNEL));

		const file = this._hooksFile();
		if (file) {
			this._register(this._files.watch(file));
			this._register(this._files.onDidFilesChange(e => {
				if (e.affects(file)) {
					this._cached = undefined;
					this._reported.clear();
				}
			}));
		}
	}

	private _folder(): URI | undefined {
		return this._workspace.getWorkspace().folders[0]?.uri;
	}

	private _hooksFile(): URI | undefined {
		const folder = this._folder();
		return folder ? joinPath(folder, ...HOOKS_FILE) : undefined;
	}

	readConfig(): Promise<VibeHookConfig> {
		if (!this._cached) {
			this._cached = this._read();
		}
		return this._cached;
	}

	private async _read(): Promise<VibeHookConfig> {
		const file = this._hooksFile();
		if (!file) {
			return { hooks: [], problems: [] };
		}
		try {
			const content = await this._files.readFile(file);
			return parseHookConfig(content.value.toString());
		} catch {
			return { hooks: [], problems: [] }; // no file is the normal case, not a problem
		}
	}

	async run(event: VibeHookEvent, context: { toolName?: string; params?: { [name: string]: unknown }; changedFiles?: readonly string[] }): Promise<VibeHookDecision> {
		try {
			const folder = this._folder();
			if (!folder) {
				return NOTHING;
			}
			if (this._configuration.getValue<boolean>(VibeHooksConfigKeys.enabled) !== true) {
				await this._offerToEnable();
				return NOTHING;
			}
			if (!this._trust.isWorkspaceTrusted()) {
				return NOTHING;
			}

			const config = await this.readConfig();
			this._reportProblems(config);
			const hooks = hooksFor(config, event, context.toolName);
			if (!hooks.length) {
				return NOTHING;
			}

			const payload: VibeHookPayload = {
				event,
				tool: context.toolName,
				params: context.params,
				cwd: folder.fsPath,
				changedFiles: context.changedFiles,
			};

			// Sequential on purpose: hooks of one event are a chain the project wrote in order,
			// and a refusal should stop the rest rather than race them.
			const verdicts = [];
			for (const hook of hooks) {
				const result = await this._main.runHook({
					command: hook.command,
					cwd: folder.fsPath,
					timeoutMs: hook.timeoutMs,
					event,
					toolName: context.toolName,
					payload,
				});
				const verdict = verdictOf({ hook, ...result });
				verdicts.push(verdict);
				if (verdict.kind === 'refuse') {
					break;
				}
			}

			const decision = decideHooks(event, verdicts);
			for (const broken of decision.brokenHooks) {
				this._notifyOnce(broken);
			}
			return decision;
		} catch (e) {
			// The machinery failing is our bug, not the project's policy: say it and let the turn go on.
			vibeLog.error('Hooks', `hook machinery failed on ${event}: ${(e as Error).message}`);
			return NOTHING;
		}
	}

	/** Says once per session that the project ships hooks while the setting is off. */
	private async _offerToEnable(): Promise<void> {
		const config = await this.readConfig();
		if (!config.hooks.length || this._reported.has('disabled')) {
			return;
		}
		this._reported.add('disabled');
		this._notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.hooks.disabled', "В проекте описаны хуки ({0} шт.), но они выключены. Хуки выполняют команды проекта — включайте только для репозиториев, которым доверяете.", config.hooks.length),
			actions: {
				primary: [{
					id: 'vibeide.hooks.enable',
					label: localize('vibeide.hooks.enable', "Включить хуки"),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => { await this._configuration.updateValue(VibeHooksConfigKeys.enabled, true); },
				}],
			},
		});
	}

	private _reportProblems(config: VibeHookConfig): void {
		for (const problem of config.problems) {
			this._notifyOnce(problem);
		}
	}

	private _notifyOnce(text: string): void {
		if (this._reported.has(text)) {
			return;
		}
		this._reported.add(text);
		vibeLog.warn('Hooks', text);
		this._notifications.warn(text);
	}
}

registerSingleton(IVibeHooksService, VibeHooksService, InstantiationType.Delayed);
