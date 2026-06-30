/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * In-memory ring buffer of recent chat-run trace events ([VibeIDE/llmTurn], [VibeIDE/toolExec]).
 *
 * The console.debug traces are ephemeral — diagnosing a stall/hang meant manually copy-pasting
 * the DevTools console. This buffer keeps the last N events with wall-clock timestamps so they
 * can be rendered into a markdown timeline on demand (command: "VibeIDE: Показать трейс прогона чата"),
 * showing the gap *between* turns at a glance — no DevTools needed.
 *
 * Deliberately a plain module (not a DI service): it is process-scoped, dependency-free, ephemeral
 * diagnostic state with no lifecycle/disposal concerns. Capped to MAX_EVENTS to bound memory.
 */

import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { vibeTraceTs } from '../common/helpers/vibeTraceTs.js';

export interface ChatTraceEvent {
	/** epoch ms, for computing gaps between events */
	readonly atMs: number;
	/** wall-clock label in chat format (DD.MM.YYYY HH:mm:ss) */
	readonly ts: string;
	/** e.g. 'llmTurn:start', 'toolExec:done' */
	readonly kind: string;
	readonly detail: Readonly<Record<string, unknown>>;
}

const MAX_EVENTS = 1000;
const BUFFER: ChatTraceEvent[] = [];

/** Record one trace event. Called next to the existing console.debug trace points. */
export function recordChatTrace(kind: string, detail: Record<string, unknown>): void {
	BUFFER.push({ atMs: Date.now(), ts: vibeTraceTs(), kind, detail });
	if (BUFFER.length > MAX_EVENTS) {
		BUFFER.splice(0, BUFFER.length - MAX_EVENTS);
	}
}

export function getChatTrace(): readonly ChatTraceEvent[] {
	return BUFFER;
}

export function clearChatTrace(): void {
	BUFFER.length = 0;
}

/** Render the buffered events as a markdown timeline, annotating the gap since the previous event. */
export function renderChatTraceMarkdown(events: readonly ChatTraceEvent[]): string {
	if (events.length === 0) {
		return '# Chat Run Timeline\n\n_Трейс пуст — запустите запрос в чате, затем откройте таймлайн снова._\n';
	}
	const lines: string[] = ['# Chat Run Timeline', '', `Событий: ${events.length}`, ''];
	let prevMs = events[0].atMs;
	for (const e of events) {
		const gapMs = e.atMs - prevMs;
		prevMs = e.atMs;
		const gap = gapMs >= 1000 ? `  _(+${(gapMs / 1000).toFixed(1)}s)_` : '';
		const detail = Object.entries(e.detail)
			.map(([k, v]) => `${k}=${typeof v === 'string' ? v : JSON.stringify(v)}`)
			.join(', ');
		lines.push(`- \`${e.ts}\` **${e.kind}** ${detail}${gap}`);
	}
	return lines.join('\n') + '\n';
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.chatRunTrace.show',
			title: { value: localize('vibeide.chatRunTrace.show', 'Показать трейс прогона чата'), original: 'Show Chat Run Timeline' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const modelService = accessor.get(ITextModelService);
		const md = renderChatTraceMarkdown(getChatTrace());
		// Proven pattern (mirrors vibeIdleWatchdogTimelineCommand): open an untitled .md and
		// inject the content via the resolved text model — not { resource: undefined, contents },
		// which compiles but does not reliably render.
		const uri = URI.parse(`untitled:VibeIDE-Chat-Run-Timeline-${Date.now()}.md`);
		await editorService.openEditor({ resource: uri, options: { pinned: true } });
		const ref = await modelService.createModelReference(uri);
		try {
			ref.object.textEditorModel.setValue(md);
		} finally {
			ref.dispose();
		}
	}
});
