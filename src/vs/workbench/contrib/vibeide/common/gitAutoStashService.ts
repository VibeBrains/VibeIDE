/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';

import { IAuditLogService } from './auditLogService.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import Severity from '../../../../base/common/severity.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { AutoStashSetting, decodeAutoStashSetting } from './autoStashPolicy.js';

// ── Configuration ─────────────────────────────────────────────────────────────
// Surface the auto-stash settings in VS Code's Settings UI. Without this block
// the keys read below by `_updateConfiguration` exist only via the `??` default,
// so users never see them in the editor and `decodeAutoStashSetting` quietly
// receives `undefined` on every load. Enum values must stay aligned with
// `AutoStashSetting` in `autoStashPolicy.ts`.

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.safety.autostash.enable': {
			type: 'boolean',
			default: true,
			description: localize('vibeide.safety.autostash.enable', 'Создавать автоматический git stash перед агентскими правками файлов. Отключение полностью выключает auto-stash независимо от режима.'),
		},
		'vibeide.safety.autostash.mode': {
			type: 'string',
			enum: ['always', 'dirty-only', 'never'],
			enumDescriptions: [
				localize('vibeide.safety.autostash.mode.always', 'Стэшить всегда перед каждой группой правок, даже на чистом дереве.'),
				localize('vibeide.safety.autostash.mode.dirty-only', 'Стэшить только если в целевых файлах есть несохранённые изменения (рекомендуется).'),
				localize('vibeide.safety.autostash.mode.never', 'Никогда не стэшить автоматически (исключение: файлы с per-file политикой "agent-protected" — для них stash принудительный).'),
			],
			default: 'dirty-only',
			description: localize('vibeide.safety.autostash.mode', 'Когда выполнять автоматический git stash перед агентскими правками. См. references/v1/git-autostash-contract.md для взаимодействия с partial rollback и checkpoint.'),
		},
	},
});

export const IGitAutoStashService = createDecorator<IGitAutoStashService>('gitAutoStashService');

export interface IGitAutoStashService {
	readonly _serviceBrand: undefined;
	isEnabled(): boolean;
	getMode(): AutoStashSetting;
	createStash(operationId: string): Promise<string | undefined>;
	restoreStash(stashRef: string): Promise<void>;
	dropStash(stashRef: string): Promise<void>;
}

class GitAutoStashService extends Disposable implements IGitAutoStashService {
	declare readonly _serviceBrand: undefined;

	private _enabled = true;
	private _mode: AutoStashSetting = 'dirty-only';
	private _stashRefs = new Map<string, string>(); // operationId -> stashRef

	/** Current auto-stash mode validated through `decodeAutoStashSetting` (roadmap §988). */
	getMode(): AutoStashSetting { return this._mode; }

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IAuditLogService private readonly _auditLogService: IAuditLogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@ICommandService private readonly _commandService: ICommandService,
	) {
		super();
		this._updateConfiguration();
		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.safety.autostash')) {
				this._updateConfiguration();
			}
		}));
	}

	private _updateConfiguration(): void {
		this._enabled = this._configurationService.getValue<boolean>('vibeide.safety.autostash.enable') ?? true;
		// Mode validated through pure helper — typo or missing value falls back to 'dirty-only' safely.
		const rawMode = this._configurationService.getValue<unknown>('vibeide.safety.autostash.mode');
		this._mode = decodeAutoStashSetting(rawMode);
		// 'never' overrides _enabled when not paired with agent-protected targets — runtime caller
		// passes editTargets/perFilePermissions to decideAutoStash; service-level isEnabled stays
		// true so the stash path remains hookable.
	}

	isEnabled(): boolean {
		return this._enabled && this._mode !== 'never';
	}

	async createStash(operationId: string): Promise<string | undefined> {
		if (!this._enabled) {
			return undefined;
		}
		// Dedup: if already stashed for this operationId, return the existing ref.
		if (this._stashRefs.has(operationId)) {
			return this._stashRefs.get(operationId);
		}

		try {
			// Check if git extension is available
			const gitExtension = await this._extensionService.getExtension('vscode.git');
			if (!gitExtension) {
				vibeLog.warn('gitAutoStash', '[GitAutoStash] Git extension not available');
				return undefined;
			}

			// Activate git extension
			await this._extensionService.activateById(gitExtension.identifier, { startup: false, extensionId: gitExtension.identifier, activationEvent: 'api' });

			// Note: git.stash command requires user interaction (prompts for message)
			// For auto-stash, we use git.stashIncludeUntracked which can be called programmatically
			// but still may prompt. This is a known limitation - proper implementation would
			// require direct git API access which isn't easily available from workbench.

			// For P0, we'll attempt stash and handle gracefully if it fails
			try {
				// Use stashIncludeUntracked which is more suitable for auto-stash
				// It will stash all changes including untracked files
				await this._commandService.executeCommand('git.stashIncludeUntracked');
			} catch (error) {
				// If stash fails (e.g., no changes, user cancelled), return undefined
				const errorStr = String(error);
				if (errorStr.includes('no changes') || errorStr.includes('cancelled')) {
					return undefined;
				}
				throw error;
			}

			// After stash, the latest stash is at index 0
			const stashRef = `stash@{0}`;
			this._stashRefs.set(operationId, stashRef);

			// Non-blocking toast
			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('autostash.created', 'Авто-stash создан: {0} — откройте Git:Stashes для просмотра.', stashRef),
				sticky: false,
			});

			// Audit log
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'git:stash',
					ok: true,
					meta: { operationId, stashRef },
				});
			}

			return stashRef;
		} catch (error) {
			vibeLog.error('gitAutoStash', '[GitAutoStash] Failed to create stash:', error);
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'git:stash',
					ok: false,
					meta: { operationId, error: String(error) },
				});
			}
			return undefined;
		}
	}

	async restoreStash(stashRef: string): Promise<void> {
		try {
			// Parse stash index from ref (format: "stash@{0}")
			const match = stashRef.match(/stash@\{(\d+)\}/);
			const stashIndex = match ? parseInt(match[1], 10) : 0;

			// For index 0 (latest), use stashPopLatest/stashApplyLatest which don't require repository
			// Try stash pop (apply and drop) first, fallback to stash apply
			if (stashIndex === 0) {
				try {
					await this._commandService.executeCommand('git.stashPopLatest');
				} catch (error) {
					// If pop fails (conflicts), try apply
					await this._commandService.executeCommand('git.stashApplyLatest');
				}
			} else {
				// For other indices, we'd need repository - this is a limitation
				// For P0, we only support latest stash (index 0)
				vibeLog.warn('gitAutoStash', `[GitAutoStash] Restore of stash@{${stashIndex}} not supported, only stash@{0} is supported`);
				throw new Error(`Only stash@{0} restore is supported`);
			}

			// Audit log
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'git:stash:restore',
					ok: true,
					meta: { stashRef },
				});
			}

			this._notificationService.notify({
				severity: Severity.Info,
				message: localize('autostash.restored', 'Применение не удалось. Рабочее дерево восстановлено из {0}.', stashRef),
				sticky: false,
			});
		} catch (error) {
			vibeLog.error('gitAutoStash', '[GitAutoStash] Failed to restore stash:', error);
			if (this._auditLogService.isEnabled()) {
				await this._auditLogService.append({
					ts: Date.now(),
					action: 'git:stash:restore',
					ok: false,
					meta: { stashRef, error: String(error) },
				});
			}
			throw error;
		}
	}

	async dropStash(stashRef: string): Promise<void> {
		try {
			// Parse stash index from ref (format: "stash@{0}")
			const match = stashRef.match(/stash@\{(\d+)\}/);
			const stashIndex = match ? parseInt(match[1], 10) : 0;
			await this._commandService.executeCommand('git.stashDrop', stashIndex);
		} catch (error) {
			vibeLog.warn('gitAutoStash', '[GitAutoStash] Failed to drop stash:', error);
		}
	}
}

registerSingleton(IGitAutoStashService, GitAutoStashService, InstantiationType.Delayed);

