/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Cloud locale sync runtime (roadmap §L517).
 *
 * Wraps the pure `decideLocaleSync` decision helper with the concrete IO:
 *   - read the local locale from VS Code's `IConfigurationService` (`vibeide.locale`)
 *   - read the cached `{ lastSyncedLocale, lastSyncedAtMs }` from `IStorageService`
 *   - GET / POST the remote locale via the user's `vibeide.cloud.localeSyncUrl`
 *
 * The wire format is intentionally minimal (no auth, no schema versioning beyond
 * `version: 1`) — when a real VibeIDE Cloud surface ships it will replace the
 * endpoint URL and add an Authorization header; the decision logic stays put.
 *
 * Pure helper: `common/cloudLocaleSync.ts` (24 unit tests, all 4 decision kinds).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { decideLocaleSync, describeLocaleSyncDecision, LocaleSyncDecision } from '../common/cloudLocaleSync.js';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.locale': {
			type: 'string',
			default: '',
			description: localize('vibeide.locale', 'Локаль VibeIDE, синхронизируемая через VibeIDE Cloud (например, `ru`, `en`, `qps-ploc`). Пустая строка — использовать локаль VS Code.'),
		},
		'vibeide.cloud.localeSyncUrl': {
			type: 'string',
			default: '',
			description: localize('vibeide.cloud.localeSyncUrl', 'HTTPS-эндпоинт VibeIDE Cloud для синхронизации локали (`GET` возвращает `{ locale, updatedAtMs }`, `POST` принимает то же). Пустая строка отключает синхронизацию.'),
		},
		'vibeide.cloud.localeSyncEnabled': {
			type: 'boolean',
			default: false,
			description: localize('vibeide.cloud.localeSyncEnabled', 'Включить периодическую синхронизацию локали с облаком. По умолчанию выключено — пока публичный эндпоинт не задан, синхронизация работает только по явной команде `VibeIDE: Sync locale with cloud`.'),
		},
	},
});

const STORAGE_KEY_LAST_LOCALE = 'vibeide.cloud.lastSyncedLocale';
const STORAGE_KEY_LAST_AT = 'vibeide.cloud.lastSyncedAtMs';

interface RemoteLocaleEnvelope {
	readonly version: 1;
	readonly locale: string;
	readonly updatedAtMs: number;
}

export interface CloudLocaleSyncResult {
	readonly decision: LocaleSyncDecision;
	readonly humanReadable: string;
	readonly applied: boolean;
}

export const IVibeCloudLocaleSyncService = createDecorator<IVibeCloudLocaleSyncService>('vibeCloudLocaleSyncService');

export interface IVibeCloudLocaleSyncService {
	readonly _serviceBrand: undefined;
	/** Run the full GET → decide → (apply | push) cycle once. */
	runSync(): Promise<CloudLocaleSyncResult>;
}

class VibeCloudLocaleSyncService extends Disposable implements IVibeCloudLocaleSyncService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _config: IConfigurationService,
		@IStorageService private readonly _storage: IStorageService,
		@ILogService private readonly _log: ILogService,
		@INotificationService private readonly _notify: INotificationService,
	) {
		super();
	}

	async runSync(): Promise<CloudLocaleSyncResult> {
		const url = (this._config.getValue<string>('vibeide.cloud.localeSyncUrl') ?? '').trim();
		const cloudEnabled = this._config.getValue<boolean>('vibeide.cloud.localeSyncEnabled') === true
			&& url.length > 0;
		const localLocale = (this._config.getValue<string>('vibeide.locale') ?? '').trim();
		const lastSyncedLocale = this._storage.get(STORAGE_KEY_LAST_LOCALE, StorageScope.APPLICATION, '') || null;
		const lastSyncedAtRaw = this._storage.get(STORAGE_KEY_LAST_AT, StorageScope.APPLICATION, '');
		const localUpdatedAtMs = lastSyncedAtRaw ? Number(lastSyncedAtRaw) : Date.now();

		// Fetch the remote envelope. A non-200 response, network error, or shape
		// mismatch is treated as "no remote known"; the decision helper then
		// either pushes (first-push) or no-ops (cloud-disabled / no-remote).
		const remote = cloudEnabled ? await this._fetchRemote(url) : null;

		const decision = decideLocaleSync({
			cloudEnabled,
			localLocale,
			remoteLocale: remote?.locale ?? null,
			localUpdatedAtMs: lastSyncedAtRaw ? Number(lastSyncedAtRaw) : null,
			remoteUpdatedAtMs: remote?.updatedAtMs ?? null,
			lastSyncedLocale,
		});

		let applied = false;
		switch (decision.kind) {
			case 'apply-remote':
				await this._applyRemoteLocale(decision.remoteLocale);
				this._storage.store(STORAGE_KEY_LAST_LOCALE, decision.remoteLocale, StorageScope.APPLICATION, StorageTarget.USER);
				this._storage.store(STORAGE_KEY_LAST_AT, String(remote?.updatedAtMs ?? Date.now()), StorageScope.APPLICATION, StorageTarget.USER);
				applied = true;
				break;
			case 'push-local':
				if (cloudEnabled) {
					const ok = await this._pushLocal(url, { version: 1, locale: decision.localLocale, updatedAtMs: localUpdatedAtMs });
					if (ok) {
						this._storage.store(STORAGE_KEY_LAST_LOCALE, decision.localLocale, StorageScope.APPLICATION, StorageTarget.USER);
						this._storage.store(STORAGE_KEY_LAST_AT, String(localUpdatedAtMs), StorageScope.APPLICATION, StorageTarget.USER);
						applied = true;
					}
				}
				break;
			case 'conflict':
				// Surface conflict; user resolves manually via Settings.
				this._notify.notify({
					severity: Severity.Warning,
					message: describeLocaleSyncDecision(decision),
				});
				break;
			case 'no-op':
				break;
		}

		const humanReadable = describeLocaleSyncDecision(decision);
		this._log.info(`[VibeIDE Cloud locale sync] ${decision.kind}/${decision.reason}: ${humanReadable} (applied=${applied})`);
		return { decision, humanReadable, applied };
	}

	private async _fetchRemote(url: string): Promise<RemoteLocaleEnvelope | null> {
		try {
			const res = await fetch(url, { method: 'GET', headers: { 'Accept': 'application/json' } });
			if (!res.ok) {
				this._log.warn(`[VibeIDE Cloud locale sync] GET non-OK status ${res.status}`);
				return null;
			}
			const data = await res.json();
			if (data && typeof data === 'object'
				&& data.version === 1
				&& typeof data.locale === 'string'
				&& typeof data.updatedAtMs === 'number'
				&& Number.isFinite(data.updatedAtMs)
			) {
				return data;
			}
			this._log.warn('[VibeIDE Cloud locale sync] GET shape mismatch');
			return null;
		} catch (err) {
			this._log.warn('[VibeIDE Cloud locale sync] GET failed', (err as Error)?.message);
			return null;
		}
	}

	private async _pushLocal(url: string, envelope: RemoteLocaleEnvelope): Promise<boolean> {
		try {
			const res = await fetch(url, {
				method: 'POST',
				headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
				body: JSON.stringify(envelope),
			});
			if (!res.ok) {
				this._log.warn(`[VibeIDE Cloud locale sync] POST non-OK status ${res.status}`);
				return false;
			}
			return true;
		} catch (err) {
			this._log.warn('[VibeIDE Cloud locale sync] POST failed', (err as Error)?.message);
			return false;
		}
	}

	private async _applyRemoteLocale(locale: string): Promise<void> {
		try {
			await this._config.updateValue('vibeide.locale', locale);
		} catch (err) {
			this._log.warn('[VibeIDE Cloud locale sync] failed to apply remote locale', (err as Error)?.message);
		}
	}
}

registerSingleton(IVibeCloudLocaleSyncService, VibeCloudLocaleSyncService, InstantiationType.Delayed);

// Palette command: `VibeIDE: Sync locale with cloud`
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.cloud.syncLocale',
			title: localize2('vibeide.cloud.syncLocale.title', 'Синхронизировать локаль с облаком'),
			category: { value: 'VibeIDE Cloud', original: 'VibeIDE Cloud' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const service = accessor.get(IVibeCloudLocaleSyncService);
		const notify = accessor.get(INotificationService);
		const result = await service.runSync();
		notify.notify({
			severity: result.applied ? Severity.Info : Severity.Info,
			message: result.humanReadable,
		});
	}
});
