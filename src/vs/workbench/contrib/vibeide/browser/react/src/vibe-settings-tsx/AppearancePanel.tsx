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
 * Selection marker for a theme row. Drawn rather than taken from an icon set so the filled state
 * follows the current theme's own accent instead of a fixed colour.
 */
const ThemeRadio = ({ checked }: { checked: boolean }) => (
	<span
		className='shrink-0 rounded-full border flex items-center justify-center'
		style={{
			width: 16,
			height: 16,
			borderColor: checked ? 'var(--vscode-focusBorder)' : 'var(--vscode-input-border, var(--vscode-editorWidget-border))',
		}}
	>
		{checked && (
			<span className='rounded-full' style={{ width: 8, height: 8, background: 'var(--vscode-focusBorder)' }} />
		)}
	</span>
);

/**
 * Three dots naming a theme faster than its label does: background, accent, and the second colour
 * that stands out. The background dot gets a hairline border — the near-black of a dark theme and
 * the white of a light one would otherwise dissolve into whichever surface they sit on.
 */
const ThemeSwatch = ({ colors }: { colors: readonly string[] }) => (
	<span className='shrink-0 flex items-center gap-1'>
		{colors.map((color, i) => (
			<span
				key={i}
				className='rounded-full'
				style={{
					width: 12,
					height: 12,
					background: color,
					boxShadow: 'inset 0 0 0 1px var(--vscode-contrastBorder, rgba(128, 128, 128, 0.35))',
				}}
			/>
		))}
	</span>
);

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

				<div className='flex flex-col mt-1 rounded-xl overflow-hidden border border-vibe-border-3'>
					{themes.map((t, index) => (
						<button
							key={t.id}
							type='button'
							role='radio'
							aria-checked={t.isCurrent}
							onClick={() => { void applyTheme(t.id); }}
							className={`flex items-center gap-3 px-4 py-3 text-sm text-left transition-colors
								${index > 0 ? 'border-t border-vibe-border-3' : ''}
								${t.isCurrent ? 'text-vibe-fg-1' : 'text-vibe-fg-2 hover:text-vibe-fg-1'}`}
							style={{
								backgroundColor: t.isCurrent
									? 'var(--vscode-list-activeSelectionBackground)'
									: 'transparent',
							}}
						>
							{isLightTheme(t) ? <Sun size={14} className='shrink-0' /> : <Moon size={14} className='shrink-0' />}
							<span className='flex-1 whitespace-nowrap'>{t.label}</span>
							{t.isOurs && <span className='text-vibe-fg-4 text-xs'>{appearanceS.ourThemeTag}</span>}

							{/* Marker first, swatch last: the eye lands on the colours, and the name is
								only needed to tell two close palettes apart. */}
							<ThemeRadio checked={t.isCurrent} />
							<ThemeSwatch colors={t.swatch} />
						</button>
					))}
					{themes.length === 0 && <span className='text-vibe-fg-3 text-sm px-4 py-3'>{appearanceS.themesEmpty}</span>}
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
