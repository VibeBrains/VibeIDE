/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { vibeLog } from '../common/vibeLog.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Categories } from '../../../../platform/action/common/actionCommonCategories.js';
import { ConfigurationScope, Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { ConfigurationTarget, IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchColorTheme, IWorkbenchThemeService } from '../../../services/themes/common/workbenchThemeService.js';

/** Settings ids of the two themes the day/night switch flips between. */
export const CONFIG_DAY_THEME = 'vibeide.theme.dayTheme';
export const CONFIG_NIGHT_THEME = 'vibeide.theme.nightTheme';

export const VIBEIDE_TOGGLE_DAY_NIGHT_COMMAND_ID = 'vibeide.theme.toggleDayNight';
export const VIBEIDE_LIST_COLOR_THEMES_COMMAND_ID = 'vibeide.theme.listColorThemes';
export const VIBEIDE_APPLY_COLOR_THEME_COMMAND_ID = 'vibeide.theme.applyColorTheme';

/**
 * Defaults: our own dark theme at night, the bundled light one by day.
 * These are theme *ids* (`contributes.themes[].id`), not the labels the picker shows — the picker
 * says «Default Light Modern» while the id is `Light Modern`, and a wrong id fails silently.
 */
const DEFAULT_DAY_THEME = 'Light Modern';
const DEFAULT_NIGHT_THEME = 'vibe-midnight';

/**
 * Themes offered in VibeIDE's own settings pane. This is deliberately a short, curated list —
 * the pane is not a replacement for the full theme picker, which stays one click away. Anything
 * the user installed from the marketplace is reachable there, not here.
 */
export const VIBEIDE_CURATED_THEME_IDS: readonly string[] = [
	'vibe-midnight',
	'vibe-graphite',
	'vibe-neon',
	'vibe-neon-noglow',
	'Dark Modern',
	'Light Modern',
];

export interface IVibeColorThemeInfo {
	readonly id: string;
	readonly label: string;
	/** 'dark' | 'light' | 'hcDark' | 'hcLight' — as reported by the theme itself. */
	readonly type: string;
	readonly isCurrent: boolean;
	/** True when this theme ships with VibeIDE rather than with upstream VS Code. */
	readonly isOurs: boolean;
}

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeideThemeSwitch',
	order: 39,
	title: localize('vibeideThemeSwitchConfigurationTitle', 'VibeIDE — Тема'),
	type: 'object',
	properties: {
		[CONFIG_DAY_THEME]: {
			type: 'string',
			default: DEFAULT_DAY_THEME,
			description: localize('vibeide.theme.dayThemeDescription', 'Светлая тема, на которую переключает кнопка «день/ночь». Указывается идентификатор темы, например «Light Modern».'),
			scope: ConfigurationScope.APPLICATION,
		},
		[CONFIG_NIGHT_THEME]: {
			type: 'string',
			default: DEFAULT_NIGHT_THEME,
			description: localize('vibeide.theme.nightThemeDescription', 'Тёмная тема, на которую переключает кнопка «день/ночь». Указывается идентификатор темы, например «vibe-midnight» или «vibe-neon».'),
			scope: ConfigurationScope.APPLICATION,
		},
	},
});

/**
 * Resolve a theme by its *settings* id — the value that lives in `workbench.colorTheme`.
 *
 * `setColorTheme(string)` does NOT accept that id: it looks the theme up by its INTERNAL id
 * (`vscode-theme-defaults-themes-light_modern-json`), so passing `Light Modern` resolves to null
 * and the call silently does nothing. Handing it the theme object side-steps the whole question.
 */
async function resolveThemeBySettingsId(themeService: IWorkbenchThemeService, settingsId: string): Promise<IWorkbenchColorTheme | undefined> {
	const installed = await themeService.getColorThemes();
	return installed.find(t => t.settingsId === settingsId);
}

/**
 * Which theme the switch should land on. Reads the CURRENT theme rather than a stored flag:
 * a flag would drift the moment the theme is changed by any other route (picker, settings file,
 * another window), and then the first click would appear to do nothing.
 */
export function pickOppositeTheme(currentSettingsId: string | undefined, dayTheme: string, nightTheme: string, currentIsDark: boolean): string {
	if (currentSettingsId === dayTheme) {
		return nightTheme;
	}
	if (currentSettingsId === nightTheme) {
		return dayTheme;
	}
	// Standing on a theme outside the configured pair (marketplace theme, upstream default):
	// fall back to its brightness, so the click still does the obvious thing.
	return currentIsDark ? dayTheme : nightTheme;
}

class ToggleDayNightThemeAction extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_TOGGLE_DAY_NIGHT_COMMAND_ID,
			title: localize2('vibeide.theme.toggleDayNight', 'VibeIDE: Переключить светлую и тёмную тему'),
			category: Categories.Preferences,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const themeService = accessor.get(IWorkbenchThemeService);
		const configurationService = accessor.get(IConfigurationService);

		const dayTheme = configurationService.getValue<string>(CONFIG_DAY_THEME) || DEFAULT_DAY_THEME;
		const nightTheme = configurationService.getValue<string>(CONFIG_NIGHT_THEME) || DEFAULT_NIGHT_THEME;

		const current = themeService.getColorTheme();
		const currentIsDark = current.type === 'dark' || current.type === 'hcDark';
		const next = pickOppositeTheme(current.settingsId, dayTheme, nightTheme, currentIsDark);

		const target = await resolveThemeBySettingsId(themeService, next);
		const applied = target ? await themeService.setColorTheme(target, ConfigurationTarget.USER) : null;
		// An unresolvable theme yields null instead of throwing — without this line the switch
		// would look like a dead button with nothing in the log to explain it.
		vibeLog.info('vibeThemeSwitch', `[day/night] ${current.settingsId} → ${next} (day=${dayTheme}, night=${nightTheme}, applied=${applied ? applied.settingsId : 'null'})`);
	}
}

class ListColorThemesAction extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_LIST_COLOR_THEMES_COMMAND_ID,
			title: localize2('vibeide.theme.listColorThemes', 'VibeIDE: Список тем оформления (для панели настроек)'),
			category: Categories.Preferences,
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<IVibeColorThemeInfo[]> {
		const themeService = accessor.get(IWorkbenchThemeService);
		const installed = await themeService.getColorThemes();
		const currentId = themeService.getColorTheme().settingsId;

		const byId = new Map(installed.map(t => [t.settingsId, t]));
		// Curated order, and only what is actually installed — a missing id must not render a
		// card that silently does nothing when clicked.
		return VIBEIDE_CURATED_THEME_IDS.flatMap(id => {
			const theme = byId.get(id);
			if (!theme) {
				return [];
			}
			return [{
				id,
				label: theme.label,
				type: String(theme.type),
				isCurrent: id === currentId,
				isOurs: id.startsWith('vibe-'),
			}];
		});
	}
}

class ApplyColorThemeAction extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_APPLY_COLOR_THEME_COMMAND_ID,
			title: localize2('vibeide.theme.applyColorTheme', 'VibeIDE: Применить тему оформления'),
			category: Categories.Preferences,
			f1: false,
		});
	}

	override async run(accessor: ServicesAccessor, themeId?: unknown): Promise<boolean> {
		if (typeof themeId !== 'string' || !themeId) {
			return false;
		}
		const themeService = accessor.get(IWorkbenchThemeService);
		const target = await resolveThemeBySettingsId(themeService, themeId);
		if (!target) {
			vibeLog.warn('vibeThemeSwitch', `[apply] theme not installed: ${themeId}`);
			return false;
		}
		const applied = await themeService.setColorTheme(target, ConfigurationTarget.USER);
		return applied !== null;
	}
}

registerAction2(ToggleDayNightThemeAction);
registerAction2(ListColorThemesAction);
registerAction2(ApplyColorThemeAction);
