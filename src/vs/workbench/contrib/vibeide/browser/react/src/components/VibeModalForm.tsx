/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import React, { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Reusable resizable modal shell: dimmed backdrop + centred window draggable from a visible
 * bottom-right grip + header (title · optional right slot · close) + a flex content area the
 * caller fills (children manage their own scroll). ESC and backdrop click close it.
 *
 * Styling rides the `.vibeide-rmodal-*` classes in vibeModal.css (themed via `--vscode-*`).
 * Inline classNames are `@@`-prefixed so scope-tailwind ships them raw. Used by the command
 * browser («VibeIDE Команды») and the project-command Add/Edit form.
 */
export interface VibeModalFormProps {
	readonly open: boolean;
	readonly title: string;
	readonly onClose: () => void;
	readonly defaultWidth?: number;
	readonly defaultHeight?: number;
	readonly minWidth?: number;
	readonly minHeight?: number;
	/** Optional node rendered between the title and the close button (e.g. a count badge). */
	readonly headerRight?: React.ReactNode;
	/** Forwarded to the root; the shell additionally closes on ESC unless the child preventDefault'd it. */
	readonly onKeyDown?: (e: React.KeyboardEvent) => void;
	readonly ariaLabel?: string;
	/** Drop the modal's default content gutter — only for content that already pads itself
	 *  (e.g. a shared form reused outside the modal). Default modals should leave this off. */
	readonly flushBody?: boolean;
	readonly children?: React.ReactNode;
}

const VIEWPORT_MARGIN = 40;

export const VibeModalForm: React.FC<VibeModalFormProps> = ({
	open, title, onClose, headerRight, onKeyDown, ariaLabel, flushBody, children,
	defaultWidth = 720, defaultHeight = 600, minWidth = 480, minHeight = 360,
}) => {
	const [size, setSize] = useState<{ w: number; h: number }>({ w: defaultWidth, h: defaultHeight });

	// Reset to the default size every time the window (re)opens.
	useEffect(() => {
		if (open) { setSize({ w: defaultWidth, h: defaultHeight }); }
	}, [open, defaultWidth, defaultHeight]);

	const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
		onKeyDown?.(e);
		if (!e.defaultPrevented && e.key === 'Escape') { e.preventDefault(); onClose(); }
	}, [onKeyDown, onClose]);

	// ── Resize from the bottom-right grip ──────────────────────────────────────
	const dragRef = useRef<{ x: number; y: number; w: number; h: number } | null>(null);
	const onGripDown = useCallback((e: React.PointerEvent) => {
		e.preventDefault();
		(e.target as HTMLElement).setPointerCapture(e.pointerId);
		dragRef.current = { x: e.clientX, y: e.clientY, w: size.w, h: size.h };
	}, [size]);
	const onGripMove = useCallback((e: React.PointerEvent) => {
		const d = dragRef.current;
		if (!d) { return; }
		setSize({
			w: Math.max(minWidth, Math.min(window.innerWidth - VIEWPORT_MARGIN, d.w + (e.clientX - d.x))),
			h: Math.max(minHeight, Math.min(window.innerHeight - VIEWPORT_MARGIN, d.h + (e.clientY - d.y))),
		});
	}, [minWidth, minHeight]);
	const onGripUp = useCallback((e: React.PointerEvent) => {
		dragRef.current = null;
		try { (e.target as HTMLElement).releasePointerCapture(e.pointerId); } catch { /* ignore */ }
	}, []);

	if (!open) { return null; }

	return (
		<div className="@@vibeide-rmodal-root" onKeyDown={handleKeyDown}>
			<div className="@@vibeide-rmodal-backdrop" onClick={onClose} />
			<div
				className="@@vibeide-rmodal-window"
				role="dialog"
				aria-modal="true"
				aria-label={ariaLabel ?? title}
				style={{ width: size.w, height: size.h }}
			>
				<div className="@@vibeide-rmodal-header">
					<span className="@@vibeide-rmodal-title">{title}</span>
					{headerRight}
					<button className="@@vibeide-rmodal-close" title="Закрыть (ESC)" onClick={onClose}>✕</button>
				</div>

				<div className={flushBody ? "@@vibeide-rmodal-body @@vibeide-rmodal-body--flush @@vibe-scroll" : "@@vibeide-rmodal-body @@vibe-scroll"}>
					{children}
				</div>

				{/* Visible bottom-right resize grip — diagonal hatching signals "drag me". */}
				<div
					className="@@vibeide-rmodal-grip"
					title="Потяните, чтобы изменить размер"
					onPointerDown={onGripDown}
					onPointerMove={onGripMove}
					onPointerUp={onGripUp}
				/>
			</div>
		</div>
	);
};
