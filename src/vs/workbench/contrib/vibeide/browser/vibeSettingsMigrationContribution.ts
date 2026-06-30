/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IUserDataProfilesService } from '../../../../platform/userDataProfile/common/userDataProfile.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';

const MIGRATION_FLAG_FILE = 'vibeide.cortexide-settings-migrated.flag';

/**
 * One-shot migration of `cortexide.*` keys in the user's settings.json to `vibeide.*`.
 *
 * Trigger: VibeIDE startup, AfterRestored phase. Side-effects:
 *   1. Read `<profile>/settings.json` once.
 *   2. If any `cortexide.*` key is found AND the equivalent `vibeide.*` key is not yet
 *      present, copy the value under the new prefix.
 *   3. Write a backup `settings.json.cortexide-backup-<ISO>.json` next to the original.
 *   4. Persist the modified settings.json with the new keys (the old `cortexide.*` keys
 *      stay in place so the user retains rollback context — they can delete them after
 *      verification).
 *   5. Drop a marker file `vibeide.cortexide-settings-migrated.flag` in the same directory
 *      so subsequent startups skip the work entirely.
 *
 * The migration is **non-destructive**: nothing is overwritten or deleted from the
 * existing settings file beyond appending the new keys. RTBF / cleanup of the legacy
 * `cortexide.*` keys is left to the user.
 */
export class VibeSettingsMigrationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSettingsMigration';

	constructor(
		@IFileService private readonly _files: IFileService,
		@IUserDataProfilesService private readonly _profiles: IUserDataProfilesService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		void this._maybeRun();
	}

	private async _maybeRun(): Promise<void> {
		try {
			const settingsResource = this._profiles.defaultProfile.settingsResource;
			const flagUri = this._flagUri(settingsResource);
			if (await this._files.exists(flagUri)) {
				return;
			}
			if (!(await this._files.exists(settingsResource))) {
				await this._writeFlag(flagUri, 'no-settings-file');
				return;
			}
			const raw = (await this._files.readFile(settingsResource)).value.toString();
			const migrated = this._migrateText(raw);
			if (!migrated.changed) {
				await this._writeFlag(flagUri, 'no-cortexide-keys');
				return;
			}
			await this._writeBackup(settingsResource, raw);
			await this._files.writeFile(settingsResource, VSBuffer.fromString(migrated.text));
			await this._writeFlag(flagUri, `migrated:${migrated.copiedKeys.length}`);
			this._notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeideSettingsMigrated',
					'VibeIDE: migrated {0} cortexide.* setting(s) to vibeide.*. A backup was saved.',
					migrated.copiedKeys.length
				),
			});
		} catch (e: unknown) {
			const message = e instanceof Error ? e.message : String(e);
			this._log.warn(`[VibeIDE settings migration] failed: ${message}`);
		}
	}

	private _flagUri(settingsResource: URI): URI {
		// Marker lives next to settings.json
		const dir = settingsResource.with({ path: settingsResource.path.replace(/\/[^/]+$/, '') });
		return joinPath(dir, MIGRATION_FLAG_FILE);
	}

	private async _writeFlag(uri: URI, reason: string): Promise<void> {
		const body = JSON.stringify({ migratedAt: new Date().toISOString(), reason }, null, 2);
		await this._files.writeFile(uri, VSBuffer.fromString(body));
	}

	private async _writeBackup(settingsResource: URI, raw: string): Promise<void> {
		const stamp = new Date().toISOString().replace(/[:.]/g, '-');
		const dir = settingsResource.with({ path: settingsResource.path.replace(/\/[^/]+$/, '') });
		const fileName = settingsResource.path.split('/').pop() ?? 'settings.json';
		const backupUri = joinPath(dir, `${fileName}.cortexide-backup-${stamp}.json`);
		await this._files.writeFile(backupUri, VSBuffer.fromString(raw));
	}

	/**
	 * Pure helper: walk the settings JSON, for each top-level cortexide.* key add a sibling
	 * vibeide.* key with the same value if absent. Preserves whitespace by writing through
	 * JSON.stringify with 2-space indent at the end (single re-serialization).
	 */
	_migrateText(raw: string): { changed: boolean; text: string; copiedKeys: string[] } {
		let parsed: Record<string, unknown>;
		try {
			parsed = JSON.parse(this._stripJsoncComments(raw));
		} catch {
			return { changed: false, text: raw, copiedKeys: [] };
		}
		if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
			return { changed: false, text: raw, copiedKeys: [] };
		}
		const copied: string[] = [];
		for (const key of Object.keys(parsed)) {
			if (!key.startsWith('cortexide.')) {
				continue;
			}
			const newKey = 'vibeide.' + key.slice('cortexide.'.length);
			if (Object.prototype.hasOwnProperty.call(parsed, newKey)) {
				continue;
			}
			parsed[newKey] = parsed[key];
			copied.push(newKey);
		}
		if (copied.length === 0) {
			return { changed: false, text: raw, copiedKeys: [] };
		}
		const out = JSON.stringify(parsed, null, '\t') + '\n';
		return { changed: true, text: out, copiedKeys: copied };
	}

	private _stripJsoncComments(s: string): string {
		// Best-effort: remove // line comments and /* */ block comments, preserve strings.
		let out = '';
		let i = 0;
		const n = s.length;
		let inString = false;
		let stringQuote: '"' | `'` | null = null;
		while (i < n) {
			const c = s[i];
			const next = s[i + 1];
			if (inString) {
				out += c;
				if (c === '\\' && i + 1 < n) {
					out += s[++i];
					i++;
					continue;
				}
				if (c === stringQuote) {
					inString = false;
					stringQuote = null;
				}
				i++;
				continue;
			}
			if (c === '"' || c === '\'') {
				inString = true;
				stringQuote = c as '"' | `'`;
				out += c;
				i++;
				continue;
			}
			if (c === '/' && next === '/') {
				while (i < n && s[i] !== '\n') { i++; }
				continue;
			}
			if (c === '/' && next === '*') {
				i += 2;
				while (i + 1 < n && !(s[i] === '*' && s[i + 1] === '/')) { i++; }
				i += 2;
				continue;
			}
			out += c;
			i++;
		}
		return out;
	}
}

registerWorkbenchContribution2(
	VibeSettingsMigrationContribution.ID,
	VibeSettingsMigrationContribution,
	WorkbenchPhase.AfterRestored
);
