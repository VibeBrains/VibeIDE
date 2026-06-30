/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { parseConfigJsonOrDefaults } from '../common/vibeConfigJsonParser.js';
import { ShellHardeningConfig } from '../common/shellHardeningTypes.js';

export const IShellHardeningService = createDecorator<IShellHardeningService>('vibeShellHardeningService');

export interface IShellHardeningService {
	readonly _serviceBrand: undefined;

	/** Snapshot of the currently-loaded workspace config (empty if none). */
	getConfig(): ShellHardeningConfig;

	/** Fires when `.vibe/shell-hardening.json` is added / changed / removed. */
	readonly onDidChange: Event<void>;
}

const EMPTY_CONFIG: ShellHardeningConfig = Object.freeze({});

/**
 * Loads and watches `.vibe/shell-hardening.json` per workspace. Pure passthrough
 * — does NOT compile regexes or apply rules; that's done by `detectShellMisuse`
 * in `toolHardening.ts`, which the caller invokes with `getConfig()`.
 *
 * Mirrors the loader pattern used by `VibeConstraintsService`:
 *   - debounced reload via RunOnceScheduler
 *   - parseConfigJsonOrDefaults for robust JSON handling
 *   - corrupt-config notification (once per change)
 *   - eager singleton (started at workbench startup, ready when toolsService
 *     validates the first command)
 */
class ShellHardeningService extends Disposable implements IShellHardeningService {
	declare readonly _serviceBrand: undefined;

	private _config: ShellHardeningConfig = EMPTY_CONFIG;
	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;
	private readonly _reloadScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._reloadScheduler = this._register(new RunOnceScheduler(() => this._reload(), 500));
		this._initWatcher();
		void this._reload();
	}

	private _getConfigUri(): URI | null {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return null; }
		return joinPath(folders[0].uri, '.vibe', 'shell-hardening.json');
	}

	private _initWatcher(): void {
		const uri = this._getConfigUri();
		if (!uri) { return; }
		try {
			const watcher = this._fileService.watch(uri);
			this._register(watcher);
			this._register(this._fileService.onDidFilesChange(e => {
				if (e.contains(uri)) {
					vibeLog.debug('ShellHardening', 'File changed, scheduling reload');
					this._reloadScheduler.schedule();
				}
			}));
		} catch {
			// File may not exist yet — watcher creation will be retried on next reload tick.
		}
	}

	private async _reload(): Promise<void> {
		const uri = this._getConfigUri();
		if (!uri) {
			this._setConfig(EMPTY_CONFIG);
			return;
		}

		let raw: string | undefined;
		try {
			const content = await this._fileService.readFile(uri);
			raw = content.value.toString();
		} catch (e) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				this._setConfig(EMPTY_CONFIG);
			} else {
				vibeLog.warn('ShellHardening', 'readFile failed for .vibe/shell-hardening.json:', e);
				this._setConfig(EMPTY_CONFIG);
			}
			return;
		}

		const parsed = parseConfigJsonOrDefaults<ShellHardeningConfig>(
			raw,
			EMPTY_CONFIG,
			reason => this._reportCorruptConfig(uri, reason),
		);
		const allow = parsed.allowedPatterns?.length ?? 0;
		const extra = parsed.extraRules?.length ?? 0;
		const disabled = parsed.disableDefaultRules?.length ?? 0;
		vibeLog.info('ShellHardening', `Loaded: allowed=${allow}, extraRules=${extra}, disabledDefaults=${disabled}`);
		this._setConfig(parsed);
	}

	private _setConfig(next: ShellHardeningConfig): void {
		this._config = next;
		this._onDidChange.fire();
	}

	private _reportCorruptConfig(uri: URI, reason: string): void {
		// Empty file is the "no overrides yet" state — never warn for that.
		if (reason === 'empty') { return; }
		vibeLog.warn('ShellHardening', `.vibe/shell-hardening.json corrupt (${reason}) — using bundled defaults only`);
		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.shellHardening.corruptConfig', 'VibeIDE: .vibe/shell-hardening.json повреждён ({0}). Применены дефолтные правила — откройте файл и исправьте JSON.', reason),
			source: 'VibeIDE ShellHardening',
			actions: {
				primary: [{
					id: 'vibeide.openCorruptShellHardeningConfig',
					label: localize('vibeide.shellHardening.openFileAction', 'Открыть файл'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => { await this._fileService.resolve(uri); },
				}],
			},
		});
	}

	getConfig(): ShellHardeningConfig {
		return this._config;
	}
}

registerSingleton(IShellHardeningService, ShellHardeningService, InstantiationType.Eager);
