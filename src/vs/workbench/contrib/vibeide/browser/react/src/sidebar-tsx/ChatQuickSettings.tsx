/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The chat's quick settings: one button under the input, a popover with the knobs people actually turn.
 *
 * The composer used to show every knob or, in the «simplified» view, hide them all behind an eye in the title bar —
 * and the hidden view forced some of them on, so what the user saw and what ran could differ.
 * Now the row keeps what is always needed (mode, model, context) and the rest sits one click away, each with its real value.
 * Config is the source of truth for every row here; the popover only reads and writes it.
 */

import { ReactNode, useCallback, useEffect, useState } from 'react';
import { autoUpdate, flip, offset, shift, size, useFloating } from '@floating-ui/react';
import { SlidersHorizontal } from 'lucide-react';
import { useAccessor } from '../util/services.js';
import { chatS } from '../vibe-settings-tsx/vibeSettingsRu.js';
import { BREVITY_SETTING, brevityLevelOf } from '../../../../common/prompt/brevity.js';
import { CLAUDE_THINKING_DISPLAY_SETTING, claudeThinkingDisplayOf } from '../../../../common/wireReasoning.js';

const RESPONSE_LANGUAGE_SETTING = 'vibeide.agent.responseLanguage';
const MINIMALISM_SETTING = 'vibeide.global.minimalismMode';

/** A configuration value, live: re-read whenever the key changes, written through the configuration service */
function useConfigSetting<T>(key: string, parse: (raw: unknown) => T): [T, (value: T) => void] {
	const accessor = useAccessor();
	const configurationService = accessor.get('IConfigurationService');
	const read = useCallback(() => parse(configurationService.getValue(key)), [configurationService, key, parse]);
	const [value, setValue] = useState<T>(read);
	useEffect(() => {
		setValue(read());
		const d = configurationService.onDidChangeConfiguration(e => { if (e.affectsConfiguration(key)) { setValue(read()); } });
		return () => d.dispose();
	}, [configurationService, key, read]);
	const write = useCallback((next: T) => { void configurationService.updateValue(key, next); }, [configurationService, key]);
	return [value, write];
}

/** One setting as a row of buttons: every choice visible at once, the current one marked */
function ChoiceRow<T extends string>({ label, title, choices, value, onChange }: { label: string; title: string; choices: readonly { readonly value: T; readonly label: string }[]; value: T; onChange: (value: T) => void }) {
	return <div className='flex flex-col gap-1 mb-2' title={title}>
		<div className='text-[11px] text-vibe-fg-3'>{label}</div>
		<div className='flex flex-wrap gap-1' role='radiogroup' aria-label={label}>
			{choices.map(choice => <button
				key={choice.value}
				type='button'
				role='radio'
				aria-checked={choice.value === value}
				onClick={() => onChange(choice.value)}
				className={`text-[11px] rounded-lg px-2 py-0.5 border ${choice.value === value ? 'border-vibe-border-1 bg-vibe-bg-2-alt text-vibe-fg-1' : 'border-vibe-border-3 text-vibe-fg-3 hover:bg-vibe-bg-2-alt'}`}
			>{choice.label}</button>)}
		</div>
	</div>;
}

const parseLanguage = (raw: unknown): 'auto' | 'ru' | 'en' => raw === 'ru' || raw === 'en' ? raw : 'auto';
const parseMinimalism = (raw: unknown): 'off' | 'lite' | 'full' | 'ultra' => raw === 'off' || raw === 'full' || raw === 'ultra' ? raw : 'lite';

/** The button and its popover; `agentControls` are the composer's own knobs, rendered inside as they are */
export const ChatQuickSettingsButton = ({ agentControls }: { agentControls: ReactNode }) => {
	const [isOpen, setIsOpen] = useState(false);
	const [brevity, setBrevity] = useConfigSetting(BREVITY_SETTING, brevityLevelOf);
	const [language, setLanguage] = useConfigSetting(RESPONSE_LANGUAGE_SETTING, parseLanguage);
	const [minimalism, setMinimalism] = useConfigSetting(MINIMALISM_SETTING, parseMinimalism);
	const [thinkingDisplay, setThinkingDisplay] = useConfigSetting(CLAUDE_THINKING_DISPLAY_SETTING, claudeThinkingDisplayOf);

	const { x, y, strategy, refs, update } = useFloating({
		open: isOpen,
		onOpenChange: setIsOpen,
		placement: 'top-start',
		middleware: [
			offset({ mainAxis: 6 }),
			flip({ boundary: document.body, padding: 8 }),
			shift({ boundary: document.body, padding: 8 }),
			size({
				apply({ availableHeight, elements }) {
					Object.assign(elements.floating.style, { maxHeight: `${Math.max(200, Math.min(availableHeight - 12, 520))}px`, overflowY: 'auto' });
				},
				padding: 8,
				boundary: document.body,
			}),
		],
		whileElementsMounted: autoUpdate,
		strategy: 'fixed',
	});

	useEffect(() => { if (isOpen) { void update(); } }, [isOpen, update]);

	useEffect(() => {
		if (!isOpen) { return; }
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Node;
			const floating = refs.floating.current;
			const reference = refs.reference.current;
			const isReferenceHTMLElement = reference && 'contains' in reference;
			if (floating && (!isReferenceHTMLElement || !reference.contains(target)) && !floating.contains(target)) {
				setIsOpen(false);
			}
		};
		const handleEscape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setIsOpen(false); } };
		document.addEventListener('mousedown', handleClickOutside);
		document.addEventListener('keydown', handleEscape);
		return () => {
			document.removeEventListener('mousedown', handleClickOutside);
			document.removeEventListener('keydown', handleEscape);
		};
	}, [isOpen, refs.floating, refs.reference]);

	return <div className='inline-flex relative shrink-0'>
		<button
			type='button'
			ref={refs.setReference}
			onClick={() => setIsOpen(v => !v)}
			className={`flex-shrink-0 p-1.5 rounded-xl transition-colors text-vibe-fg-3 ${isOpen ? 'bg-vibe-bg-2-alt' : 'hover:bg-vibe-bg-2-alt'}`}
			aria-label={chatS.quickSettingsTitle}
			aria-expanded={isOpen}
			data-tooltip-id='vibe-tooltip'
			data-tooltip-content={brevity === 'off' ? chatS.quickSettingsTitle : chatS.quickSettingsTooltip(chatS.brevityChoice(brevity))}
			data-tooltip-place='top'
			data-tooltip-delay-show={1000}
		>
			<SlidersHorizontal size={14} />
		</button>
		{isOpen ? <div
			ref={refs.setFloating}
			style={{ position: strategy, top: y ?? 0, left: x ?? 0, minWidth: '280px', maxWidth: 'min(92vw, 380px)' }}
			className='z-50 rounded-2xl shadow-xl bg-vibe-bg-1 border border-vibe-border-3 p-3 text-vibe-fg-2'
			role='dialog'
			aria-label={chatS.quickSettingsTitle}
		>
			<div className='text-[11px] font-semibold text-vibe-fg-2 mb-2'>{chatS.quickSettingsAnswers}</div>
			<ChoiceRow
				label={chatS.brevityLabel}
				title={chatS.brevityTitle}
				value={brevity}
				onChange={setBrevity}
				choices={(['off', 'lite', 'full', 'ultra'] as const).map(value => ({ value, label: chatS.brevityChoice(value) }))}
			/>
			<ChoiceRow
				label={chatS.responseLanguageLabel}
				title={chatS.responseLanguageTitle}
				value={language}
				onChange={setLanguage}
				choices={(['auto', 'ru', 'en'] as const).map(value => ({ value, label: chatS.responseLanguageChoice(value) }))}
			/>
			<ChoiceRow
				label={chatS.thinkingDisplayLabel}
				title={chatS.thinkingDisplayTitle}
				value={thinkingDisplay}
				onChange={setThinkingDisplay}
				choices={(['summarized', 'updates', 'omitted'] as const).map(value => ({ value, label: chatS.thinkingDisplayChoice(value) }))}
			/>
			<ChoiceRow
				label={chatS.minimalismLabel}
				title={chatS.minimalismTitle}
				value={minimalism}
				onChange={setMinimalism}
				choices={(['off', 'lite', 'full', 'ultra'] as const).map(value => ({ value, label: chatS.minimalismChoice(value) }))}
			/>
			<div className='text-[11px] font-semibold text-vibe-fg-2 mt-3 mb-2'>{chatS.quickSettingsAgent}</div>
			<div className='flex flex-wrap items-center gap-x-2 gap-y-1.5'>
				{agentControls}
			</div>
		</div> : null}
	</div>;
};
