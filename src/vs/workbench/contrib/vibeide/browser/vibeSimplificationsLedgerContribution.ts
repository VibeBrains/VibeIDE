/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Deferred-simplifications ledger.
 *
 * Convention: a `vibe-later: <what and why>` comment marks a simplification that
 * was consciously deferred (the agent leaves them in minimalism full/ultra modes,
 * and users can too). Command `vibeide.simplifications.scan` harvests every marker
 * across the workspace via ISearchService (ripgrep) and opens the ledger as an
 * untitled markdown report — same surface as the Idle Watchdog timeline.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor, IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { ISearchService } from '../../../services/search/common/search.js';
import { QueryBuilder } from '../../../services/search/common/queryBuilder.js';
import { CancellationTokenSource } from '../../../../base/common/cancellation.js';
import { localize, localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { basename } from '../../../../base/common/resources.js';

/** Comment marker harvested by the ledger; also referenced in the minimalism prompt block (prompts.ts). */
export const VIBE_LATER_MARKER = 'vibe-later:';

const MAX_LEDGER_RESULTS = 500;
const SCAN_TIMEOUT_MS = 30_000;

type LedgerEntry = { uri: URI; line: number; text: string };

// Search backends return slightly different result shapes across versions
// (`rangeLocations` vs legacy `range`/`rangeStart*`); probe each optional field.
type ResultProbe = {
	preview?: { text?: unknown };
	rangeLocations?: Array<{ source?: { startLineNumber?: number } }>;
	rangeStartLineNumber?: number;
	range?: { startLineNumber?: number };
};

class VibeSimplificationsScanAction extends Action2 {
	static readonly ID = 'vibeide.simplifications.scan';

	constructor() {
		super({
			id: VibeSimplificationsScanAction.ID,
			title: localize2('vibeide.simplifications.scan.title', 'Леджер отложенных упрощений (vibe-later)'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const searchService = accessor.get(ISearchService);
		const workspaceContextService = accessor.get(IWorkspaceContextService);
		const instantiationService = accessor.get(IInstantiationService);
		const editorService = accessor.get(IEditorService);
		const modelService = accessor.get(ITextModelService);
		const notificationService = accessor.get(INotificationService);

		const folders = workspaceContextService.getWorkspace().folders.map(f => f.uri);
		if (folders.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.simplifications.noWorkspace', 'Нет открытой рабочей области — сканировать нечего.') });
			return;
		}

		const queryBuilder = instantiationService.createInstance(QueryBuilder);
		const textQuery = queryBuilder.text({
			pattern: VIBE_LATER_MARKER,
			isRegExp: false,
			isCaseSensitive: false,
		}, folders, {
			expandPatterns: true,
			maxResults: MAX_LEDGER_RESULTS,
		});

		// Bounded scan: a huge repo must not hang the workbench on a palette command.
		const cts = new CancellationTokenSource();
		const timer = setTimeout(() => cts.cancel(), SCAN_TIMEOUT_MS);
		let data: Awaited<ReturnType<typeof searchService.textSearch>>;
		try {
			data = await searchService.textSearch(textQuery, cts.token);
		} catch (e) {
			notificationService.notify({ severity: Severity.Error, message: localize('vibeide.simplifications.scanFailed', 'Скан vibe-later не удался: {0}', String(e)) });
			return;
		} finally {
			clearTimeout(timer);
			cts.dispose();
		}

		const entries: LedgerEntry[] = [];
		for (const fileMatch of data.results) {
			if (!Array.isArray(fileMatch.results)) { continue; }
			for (const r of fileMatch.results) {
				const probe = r as ResultProbe;
				const previewText = typeof probe.preview?.text === 'string' ? probe.preview.text : null;
				if (previewText === null) { continue; }
				const line = probe.rangeLocations?.[0]?.source?.startLineNumber
					?? probe.rangeStartLineNumber
					?? probe.range?.startLineNumber
					?? 1;
				entries.push({ uri: fileMatch.resource, line, text: previewText.trim() });
			}
		}

		const md = renderLedgerMarkdown(entries, data.limitHit === true);
		const uri = URI.parse(`untitled:VibeIDE-Simplifications-Ledger-${Date.now()}.md`);
		await editorService.openEditor({ resource: uri, options: { pinned: true } });
		const ref = await modelService.createModelReference(uri);
		try {
			ref.object.textEditorModel.setValue(md);
		} finally {
			ref.dispose();
		}
	}
}

function renderLedgerMarkdown(entries: readonly LedgerEntry[], limitHit: boolean): string {
	const lines: string[] = [];
	lines.push(localize('vibeide.simplifications.ledger.title', '# VibeIDE — Леджер отложенных упрощений'));
	lines.push('');
	lines.push(localize('vibeide.simplifications.ledger.intro', 'Маркеры `vibe-later:` — упрощения, сознательно отложенные при написании кода (агентом в режимах минимализма full/ultra или вручную). Каждая запись — кандидат на удаление/упрощение кода.'));
	lines.push('');

	if (entries.length === 0) {
		lines.push(localize('vibeide.simplifications.ledger.empty', '_Маркеров не найдено — долгов по упрощениям нет._'));
		return lines.join('\n');
	}

	// Group by file so the ledger reads as a per-file worklist.
	const byFile = new Map<string, LedgerEntry[]>();
	for (const e of entries) {
		const key = e.uri.fsPath;
		const arr = byFile.get(key) ?? [];
		arr.push(e);
		byFile.set(key, arr);
	}

	lines.push(localize('vibeide.simplifications.ledger.total', 'Всего: **{0}** в **{1}** файлах.', entries.length, byFile.size));
	lines.push('');
	for (const [fsPath, fileEntries] of byFile.entries()) {
		lines.push(`## ${basename(fileEntries[0].uri)}`);
		lines.push('');
		for (const e of fileEntries.sort((a, b) => a.line - b.line)) {
			// `path:line` renders as a clickable link in the editor.
			const afterMarker = e.text.slice(e.text.toLowerCase().indexOf(VIBE_LATER_MARKER) + VIBE_LATER_MARKER.length).trim();
			lines.push(`- ${fsPath}:${e.line} — ${afterMarker || e.text}`);
		}
		lines.push('');
	}

	if (limitHit) {
		lines.push(localize('vibeide.simplifications.ledger.limit', '_Показаны первые {0} результатов — лимит скана достигнут._', MAX_LEDGER_RESULTS));
	}
	return lines.join('\n');
}

registerAction2(VibeSimplificationsScanAction);
