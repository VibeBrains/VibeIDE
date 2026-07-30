/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import React from 'react';
import { useAccessor, useSettingsState } from '../util/services.js';
import { VIBE_AGENT_ROLE_PRESETS } from '../../../../common/vibeSubagentRegistryService.js';

// Dropdown chevron as an inline data-URI (muted gray so it reads in both themes). Used because the
// select has appearance:none (native chrome removed to allow theming), which also strips the arrow.
const SELECT_CHEVRON = "url(\"data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' width='12' height='12' viewBox='0 0 12 12'><path d='M2.5 4.5l3.5 3.5 3.5-3.5' fill='none' stroke='%23888' stroke-width='1.4' stroke-linecap='round' stroke-linejoin='round'/></svg>\")";

// Themed <select> styling via inline styles (not a CSS class): this card is a shared cross-bundle
// component and `appearance: base-select` is unsupported by the app's Chromium, so we mirror the
// modal input tokens (bg / border / radius) and force `appearance: none` for reliable theming.
/** Mirrors `roleSelectStyle` so the budget field sits in the same visual row as the model picker. */
const roleBudgetInputStyle: React.CSSProperties = {
	width: '120px',
	boxSizing: 'border-box',
	padding: '6px 10px',
	backgroundColor: 'var(--vscode-input-background)',
	color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border, var(--vscode-commandCenter-border, transparent))',
	borderRadius: '8px',
};

const roleSelectStyle: React.CSSProperties = {
	width: '100%',
	boxSizing: 'border-box',
	padding: '6px 28px 6px 10px',
	backgroundColor: 'var(--vscode-input-background)',
	color: 'var(--vscode-input-foreground)',
	border: '1px solid var(--vscode-input-border, var(--vscode-commandCenter-border, transparent))',
	borderRadius: '8px',
	appearance: 'none',
	WebkitAppearance: 'none',
	MozAppearance: 'none',
	cursor: 'pointer',
	backgroundImage: SELECT_CHEVRON,
	backgroundRepeat: 'no-repeat',
	backgroundPosition: 'right 10px center',
};

// Small bordered pill shown next to a role name (e.g. «только чтение», «🖼 картинки»).
const roleBadgeStyle: React.CSSProperties = {
	fontSize: '10px',
	whiteSpace: 'nowrap',
	border: '1px solid var(--vscode-input-border, var(--vscode-widget-border, transparent))',
	borderRadius: '4px',
	padding: '0 4px',
};

/**
 * Per-role model mapping for Vibe Agents (VA.2). Shared between the Settings page and the in-chat
 * «Роли» modal (opened from the route launcher) — a plain select per role over the computed model
 * options + «как в чате» (no mapping). Read-only roles get a badge; caller supplies the header.
 */
export const AgentRoleModels = () => {
	const accessor = useAccessor();
	const vibeideSettingsService = accessor.get('IVibeideSettingsService');
	const settingsState = useSettingsState();

	return (
		<>
			<div className='text-sm text-vibe-fg-3 mt-1'>
				Какая модель исполняет каждую роль Vibe Agents. По умолчанию — модель чата. Read-only роли
				(планировщик, ревьюер, security) выгодно сажать на лёгкую модель: дешевле и быстрее, а
				писать код им всё равно запрещено. Бюджет — потолок суммарного расхода роли за окно
				(по умолчанию сутки, ключ <code>vibeide.subagent.budgetWindowDays</code>): пусто —
				без ограничения. Исчерпав его, роль не запустится, а прогон появится в
				«Диспетчерской» как пропущенный с причиной.
			</div>
			{/* Inline styles (not Tailwind utilities) for the layout: this card is a shared
			    cross-bundle component (Settings page + in-chat modal), and the modal bundle's
			    Tailwind CSS does not generate every layout/border utility — only text size/color
			    classes are reliably present. Inline styles render identically in any bundle. */}
			<div
				style={{
					display: 'grid',
					gridTemplateColumns: 'max-content minmax(0, 1fr) max-content',
					alignItems: 'center',
					columnGap: '12px',
					rowGap: '6px',
					margin: '8px 0',
				}}
			>
				{VIBE_AGENT_ROLE_PRESETS.map(preset => {
					const current = settingsState.modelSelectionOfRole?.[preset.type] ?? null;
					const currentKey = current ? `${current.providerName}:::${current.modelName}` : '';
					const isReadOnly = !preset.allowedTools.some(t => t === 'edit_file' || t === 'rewrite_file' || t === 'run_command');
					return (
						<React.Fragment key={preset.type}>
							<div style={{ display: 'flex', alignItems: 'center', gap: '6px' }}>
								<span className='text-xs text-vibe-fg-2'>{preset.displayName}</span>
								{isReadOnly && (
									<span className='text-vibe-fg-3' style={roleBadgeStyle}>только чтение</span>
								)}
								{preset.receivesImages && (
									<span className='text-vibe-fg-3' style={roleBadgeStyle} title='Роль разбирает приложенные картинки — по умолчанию берёт vision-модель'>🖼 картинки</span>
								)}
							</div>
							<select
								className='text-xs'
								style={roleSelectStyle}
								value={currentKey}
								onChange={(e) => {
									const v = e.target.value;
									if (!v) { void vibeideSettingsService.setModelSelectionOfRole(preset.type, null); return; }
									const opt = settingsState._modelOptions.find(o => `${o.selection.providerName}:::${o.selection.modelName}` === v);
									if (opt) { void vibeideSettingsService.setModelSelectionOfRole(preset.type, opt.selection); }
								}}
							>
								<option value=''>как в чате</option>
								{settingsState._modelOptions.map(o => (
									<option key={`${o.selection.providerName}:::${o.selection.modelName}`} value={`${o.selection.providerName}:::${o.selection.modelName}`}>
										{o.name}
									</option>
								))}
							</select>
							<input
								className='text-xs'
								style={roleBudgetInputStyle}
								type='number'
								min={0}
								step={10000}
								placeholder='без лимита'
								title='Потолок суммарного расхода роли за окно бюджета. Пусто или 0 — без ограничения.'
								value={settingsState.tokenBudgetOfRole?.[preset.type] ?? ''}
								onChange={(e) => {
									const raw = e.target.value.trim();
									void vibeideSettingsService.setTokenBudgetOfRole(preset.type, raw === '' ? null : Number(raw));
								}}
							/>
						</React.Fragment>
					);
				})}
			</div>
		</>
	);
};
