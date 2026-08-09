/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React, { useCallback, useEffect, useState } from 'react';
import { Sun, Moon } from 'lucide-react';
import { useAccessor, useIsDark } from '../util/services.js';
import { VibeButtonBgDarken, VibeCustomDropdownBox } from '../util/inputs.js';
import { appearanceS } from './vibeSettingsRu.js';
import {
	VIBEIDE_APPLY_COLOR_THEME_COMMAND_ID,
	VIBEIDE_LIST_COLOR_THEMES_COMMAND_ID,
	VIBEIDE_TOGGLE_DAY_NIGHT_COMMAND_ID,
	CONFIG_DAY_THEME,
	CONFIG_NIGHT_THEME,
	type IVibeColorThemeInfo,
} from '../../../vibeThemeSwitch.js';

/** Themes the day/night switch may be pointed at, split by brightness. */
const isLightTheme = (t: IVibeColorThemeInfo) => t.type === 'light' || t.type === 'hcLight';

/**
 * «Оформление» — a short, curated theme picker plus the day/night pair.
 * Deliberately not a mirror of the full VS Code picker: marketplace themes stay one click away
 * through the «Все темы» button, so this pane can show what we ship without becoming a list.
 */
export const AppearancePanel = () => {
	const accessor = useAccessor();
	const commandService = accessor.get('ICommandService');
	const configurationService = accessor.get('IConfigurationService');
	const isDark = useIsDark();

	const [themes, setThemes] = useState<IVibeColorThemeInfo[]>([]);
	const [dayTheme, setDayTheme] = useState<string>(() => configurationService.getValue<string>(CONFIG_DAY_THEME) ?? '');
	const [nightTheme, setNightTheme] = useState<string>(() => configurationService.getValue<string>(CONFIG_NIGHT_THEME) ?? '');

	const refresh = useCallback(async () => {
		const list = await commandService.executeCommand<IVibeColorThemeInfo[]>(VIBEIDE_LIST_COLOR_THEMES_COMMAND_ID);
		setThemes(list ?? []);
	}, [commandService]);

	useEffect(() => { void refresh(); }, [refresh]);

	// The active theme can change from anywhere (picker, the chat switch, another window), so the
	// «current» marker is re-read on every theme change rather than tracked locally.
	useEffect(() => { void refresh(); }, [isDark, refresh]);

	useEffect(() => {
		const d = configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_DAY_THEME)) {
				setDayTheme(configurationService.getValue<string>(CONFIG_DAY_THEME) ?? '');
			}
			if (e.affectsConfiguration(CONFIG_NIGHT_THEME)) {
				setNightTheme(configurationService.getValue<string>(CONFIG_NIGHT_THEME) ?? '');
			}
		});
		return () => d.dispose();
	}, [configurationService]);

	const applyTheme = useCallback(async (id: string) => {
		await commandService.executeCommand(VIBEIDE_APPLY_COLOR_THEME_COMMAND_ID, id);
		await refresh();
	}, [commandService, refresh]);

	const lightThemes = themes.filter(isLightTheme);
	const darkThemes = themes.filter(t => !isLightTheme(t));

	return (
		<div className='flex flex-col gap-8'>

			<div className='flex flex-col gap-2'>
				<h3 className='text-vibe-fg-1 text-base font-medium'>{appearanceS.themesTitle}</h3>
				<p className='text-vibe-fg-3 text-sm'>{appearanceS.themesHint}</p>

				<div className='flex flex-row flex-wrap gap-2 mt-1'>
					{themes.map(t => (
						<button
							key={t.id}
							type='button'
							onClick={() => { void applyTheme(t.id); }}
							className={`flex items-center gap-2 px-3 py-2 rounded-xl border text-sm transition-colors
								${t.isCurrent
									? 'border-vibe-border-1 text-vibe-fg-1'
									: 'border-vibe-border-3 text-vibe-fg-2 hover:text-vibe-fg-1'}`}
							style={{
								backgroundColor: t.isCurrent
									? 'var(--vscode-list-activeSelectionBackground)'
									: 'var(--vscode-input-background)',
							}}
						>
							{isLightTheme(t) ? <Sun size={14} /> : <Moon size={14} />}
							<span className='whitespace-nowrap'>{t.label}</span>
							{t.isOurs && <span className='text-vibe-fg-4 text-xs'>{appearanceS.ourThemeTag}</span>}
						</button>
					))}
					{themes.length === 0 && <span className='text-vibe-fg-3 text-sm'>{appearanceS.themesEmpty}</span>}
				</div>

				<div className='mt-2'>
					<VibeButtonBgDarken className='px-4 py-1' onClick={() => { void commandService.executeCommand('workbench.action.selectTheme'); }}>
						{appearanceS.allThemesButton}
					</VibeButtonBgDarken>
				</div>
			</div>

			<div className='flex flex-col gap-2'>
				<h3 className='text-vibe-fg-1 text-base font-medium'>{appearanceS.dayNightTitle}</h3>
				<p className='text-vibe-fg-3 text-sm'>{appearanceS.dayNightHint}</p>

				<div className='flex flex-row flex-wrap items-center gap-4 mt-1'>
					<label className='flex items-center gap-2 text-sm text-vibe-fg-2'>
						<Sun size={14} />
						<span>{appearanceS.dayThemeLabel}</span>
						<VibeCustomDropdownBox
							options={lightThemes.map(t => t.id)}
							selectedOption={lightThemes.some(t => t.id === dayTheme) ? dayTheme : undefined}
							onChangeOption={id => { void configurationService.updateValue(CONFIG_DAY_THEME, id); }}
							getOptionDisplayName={id => lightThemes.find(t => t.id === id)?.label ?? id}
							getOptionDropdownName={id => lightThemes.find(t => t.id === id)?.label ?? id}
							getOptionsEqual={(a, b) => a === b}
							className='text-xs'
						/>
					</label>

					<label className='flex items-center gap-2 text-sm text-vibe-fg-2'>
						<Moon size={14} />
						<span>{appearanceS.nightThemeLabel}</span>
						<VibeCustomDropdownBox
							options={darkThemes.map(t => t.id)}
							selectedOption={darkThemes.some(t => t.id === nightTheme) ? nightTheme : undefined}
							onChangeOption={id => { void configurationService.updateValue(CONFIG_NIGHT_THEME, id); }}
							getOptionDisplayName={id => darkThemes.find(t => t.id === id)?.label ?? id}
							getOptionDropdownName={id => darkThemes.find(t => t.id === id)?.label ?? id}
							getOptionsEqual={(a, b) => a === b}
							className='text-xs'
						/>
					</label>

					<VibeButtonBgDarken
						className='px-4 py-1'
						onClick={() => { void commandService.executeCommand(VIBEIDE_TOGGLE_DAY_NIGHT_COMMAND_ID).then(refresh); }}
					>
						{appearanceS.switchNowButton}
					</VibeButtonBgDarken>
				</div>
			</div>
		</div>
	);
};
