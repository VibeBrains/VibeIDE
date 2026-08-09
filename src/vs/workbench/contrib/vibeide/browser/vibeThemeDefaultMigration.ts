/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * One-time move of existing installs from `vibe-neon` to `vibe-midnight`.
 *
 * Changing `configurationDefaults` only reaches users who never had the setting written. Anyone
 * who has opened VibeIDE before carries an explicit `workbench.colorTheme` in their settings, so
 * without this they would keep neon forever.
 *
 * Three deliberate limits, because rewriting a user's setting is intrusive:
 *  1. Only the exact old default (`vibe-neon`) is touched. Someone on One Dark Pro, on the light
 *     theme, or on `vibe-neon-noglow` chose that — a migration must not overrule a choice.
 *  2. It runs once, recorded in application storage. Switching back to neon afterwards sticks.
 *  3. It says so, with a one-click undo. A theme changing by itself is otherwise alarming.
 */

import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';
import { vibeLog } from '../common/vibeLog.js';

const COLOR_THEME_SETTING = 'workbench.colorTheme';
const PREFERRED_DARK_SETTING = 'workbench.preferredDarkColorTheme';

const OLD_DEFAULT_THEME = 'vibe-neon';
const NEW_DEFAULT_THEME = 'vibe-midnight';

/** Bump the suffix only if a future migration must run again for users already migrated once. */
const MIGRATION_STORAGE_KEY = 'vibeide.theme.defaultMigration.midnight.v1';

/**
 * Pure decision: which settings should move. Returns the keys to rewrite — empty when the user is
 * not on the old default, so the caller can skip both the write and the notification.
 */
export function planThemeMigration(colorTheme: string | undefined, preferredDark: string | undefined): readonly string[] {
	const keys: string[] = [];
	if (colorTheme === OLD_DEFAULT_THEME) {
		keys.push(COLOR_THEME_SETTING);
	}
	// Only follow along when the main theme moves: a lone preferredDark on neon is a paired
	// setting for auto-switching, and rewriting it alone would break that pairing silently.
	if (keys.length > 0 && preferredDark === OLD_DEFAULT_THEME) {
		keys.push(PREFERRED_DARK_SETTING);
	}
	return keys;
}

class VibeThemeDefaultMigrationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideThemeDefaultMigration';

	constructor(
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IStorageService private readonly _storageService: IStorageService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IWorkbenchThemeService private readonly _themeService: IWorkbenchThemeService,
	) {
		super();
		void this._migrateOnce();
	}

	private async _migrateOnce(): Promise<void> {
		if (this._storageService.getBoolean(MIGRATION_STORAGE_KEY, StorageScope.APPLICATION, false)) {
			return;
		}

		// Read the USER value specifically: the new shipped default also reads as `vibe-midnight`
		// through getValue(), and a defaults-only install needs no migration at all.
		const colorTheme = this._configurationService.inspect<string>(COLOR_THEME_SETTING).userValue;
		const preferredDark = this._configurationService.inspect<string>(PREFERRED_DARK_SETTING).userValue;
		const keys = planThemeMigration(colorTheme, preferredDark);

		// Mark it done either way — a user who is not on the old default must not be re-checked
		// (and possibly migrated) after they later switch to neon on purpose.
		this._storageService.store(MIGRATION_STORAGE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);

		if (keys.length === 0) {
			return;
		}

		try {
			for (const key of keys) {
				await this._configurationService.updateValue(key, NEW_DEFAULT_THEME, ConfigurationTarget.USER);
			}
			vibeLog.info('vibeThemeMigration', `[default-theme] ${OLD_DEFAULT_THEME} → ${NEW_DEFAULT_THEME} (${keys.join(', ')})`);
			this._notifyWithUndo();
		} catch (err) {
			vibeLog.warn('vibeThemeMigration', `[default-theme] migration failed: ${err}`);
		}
	}

	private _notifyWithUndo(): void {
		this._notificationService.prompt(
			Severity.Info,
			localize('vibeide.theme.migrated', 'Тема по умолчанию сменилась на «Vibe Midnight» — спокойнее и ближе к привычным редакторам. Vibe Neon остался в списке тем.'),
			[{
				label: localize('vibeide.theme.migratedUndo', 'Вернуть Vibe Neon'),
				run: () => {
					void (async () => {
						const themes = await this._themeService.getColorThemes();
						const neon = themes.find(t => t.settingsId === OLD_DEFAULT_THEME);
						if (neon) {
							await this._themeService.setColorTheme(neon, ConfigurationTarget.USER);
						}
					})();
				},
			}],
			// Sticky: an Info toast auto-dismisses after ~15s, and the whole point is that the
			// user sees WHY their theme changed. Measured live — the notification was gone before
			// the first look at the window.
			{ sticky: true },
		);
	}
}

registerWorkbenchContribution2(VibeThemeDefaultMigrationContribution.ID, VibeThemeDefaultMigrationContribution, WorkbenchPhase.AfterRestored);
