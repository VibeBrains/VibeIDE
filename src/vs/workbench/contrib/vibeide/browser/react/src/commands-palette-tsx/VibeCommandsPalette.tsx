/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../../../../common/vibeLog.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useAccessor } from '../util/services.js';
import { collectVibeideCommands, VibeCommandEntry } from '../../../vibeideCommandCatalog.js';
import { VibeModalForm } from '../components/VibeModalForm.js';

/**
 * «VibeIDE Команды» — a resizable modal window that mirrors EVERY VibeIDE command
 * (every Command-Palette entry whose id starts with `vibe`). Click a row to run it.
 * The resizable window chrome lives in the shared `VibeModalForm`; this component
 * owns the searchable, keyboard-navigable command list. Inline classNames are `@@`-prefixed
 * so scope-tailwind ships them raw (matches the CSS class names in vibeModal.css).
 */
export const VibeCommandsPalette: React.FC = () => {
	const accessor = useAccessor();
	const paletteService = accessor.get('IVibeCommandsPaletteService');
	const commandService = accessor.get('ICommandService');
	const keybindingService = accessor.get('IKeybindingService');

	const [open, setOpen] = useState<boolean>(() => paletteService.isOpen);
	const [query, setQuery] = useState('');
	const [activeIndex, setActiveIndex] = useState(0);
	const [commands, setCommands] = useState<VibeCommandEntry[]>([]);

	const inputRef = useRef<HTMLInputElement | null>(null);
	const listRef = useRef<HTMLDivElement | null>(null);

	// Open/close driven by the service.
	useEffect(() => {
		const sub = paletteService.onDidChangeOpen((v) => setOpen(v));
		return () => sub.dispose();
	}, [paletteService]);

	// (Re)enumerate commands every time the window opens — commands can register
	// late, so a fresh read on open keeps the list complete.
	useEffect(() => {
		if (!open) { return; }
		setCommands(collectVibeideCommands(keybindingService));
		setQuery('');
		setActiveIndex(0);
		requestAnimationFrame(() => inputRef.current?.focus());
	}, [open, keybindingService]);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) { return commands; }
		return commands.filter(c =>
			c.title.toLowerCase().includes(q) || c.category.toLowerCase().includes(q) || c.id.toLowerCase().includes(q));
	}, [commands, query]);

	const close = useCallback(() => paletteService.close(), [paletteService]);

	const run = useCallback(async (id: string) => {
		paletteService.close();
		try {
			await commandService.executeCommand(id);
		} catch (err) {
			vibeLog.warn('VibeCommandsPalette', `[VibeCommandsPalette] command failed: ${id}`, err);
		}
	}, [commandService, paletteService]);

	// Keyboard: Arrow keys move selection, Enter runs the highlighted row. (ESC → shell closes.)
	const onKeyDown = useCallback((e: React.KeyboardEvent) => {
		if (e.key === 'ArrowDown') {
			e.preventDefault();
			setActiveIndex(i => Math.min(i + 1, filtered.length - 1));
		} else if (e.key === 'ArrowUp') {
			e.preventDefault();
			setActiveIndex(i => Math.max(i - 1, 0));
		} else if (e.key === 'Enter') {
			e.preventDefault();
			const cmd = filtered[activeIndex];
			if (cmd) { void run(cmd.id); }
		}
	}, [filtered, activeIndex, run]);

	// Keep the highlighted row in view as the selection moves via keyboard.
	useEffect(() => {
		const el = listRef.current?.querySelector<HTMLElement>(`[data-idx="${activeIndex}"]`);
		el?.scrollIntoView({ block: 'nearest' });
	}, [activeIndex]);

	return (
		<VibeModalForm
			open={open}
			title="VibeIDE Команды"
			onClose={close}
			onKeyDown={onKeyDown}
			defaultWidth={800}
			defaultHeight={600}
			headerRight={<span className="@@vibeide-cmdpalette-count">{filtered.length}</span>}
		>
			<input
				ref={inputRef}
				className="@@vibeide-cmdpalette-search"
				type="text"
				placeholder="Фильтр команд…"
				value={query}
				onChange={(e) => { setQuery(e.target.value); setActiveIndex(0); }}
			/>
			<div className="@@vibeide-cmdpalette-list" ref={listRef}>
				{filtered.length === 0 && (
					<div className="@@vibeide-cmdpalette-empty">Ничего не найдено</div>
				)}
				{filtered.map((c, i) => (
					<button
						key={c.id}
						data-idx={i}
						className={i === activeIndex ? '@@vibeide-cmdpalette-item is-active' : '@@vibeide-cmdpalette-item'}
						onMouseMove={() => setActiveIndex(i)}
						onClick={() => run(c.id)}
						title={c.id}
					>
						<span className="@@vibeide-cmdpalette-item-main">
							{c.category && <span className="@@vibeide-cmdpalette-item-cat">{c.category}:</span>}
							<span className="@@vibeide-cmdpalette-item-title">{c.title || c.id}</span>
						</span>
						{c.keybinding && <span className="@@vibeide-cmdpalette-item-kbd">{c.keybinding}</span>}
					</button>
				))}
			</div>
		</VibeModalForm>
	);
};
