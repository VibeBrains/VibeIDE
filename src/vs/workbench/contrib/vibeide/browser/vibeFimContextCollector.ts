/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * FIM runtime context-collection pipeline (roadmap §1018/1019).
 *
 * Assembles a FIMContext from live VS Code editor state:
 *   - Active editor prefix/suffix around the primary cursor
 *   - Open tab snippets (top-N by last access time)
 *   - Recent edits (last N model content-change events, stored in a ring buffer)
 *   - Project rules from .vibe/rules.md
 *
 * Returned context is trimmed to FIM_BUDGET_DEFAULTS via `reportFIMBudget`.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { isCodeEditor } from '../../../../editor/browser/editorBrowser.js';
import {
	type FIMContext,
	type FIMCurrentFile,
	type FIMOpenTab,
	type FIMRecentEdit,
	reportFIMBudget,
	trimCurrentFileToBudget,
	FIM_BUDGET_DEFAULTS,
} from '../common/fimContextContract.js';

export const IVibeFimContextCollector = createDecorator<IVibeFimContextCollector>('vibeFimContextCollector');

export interface IVibeFimContextCollector {
	readonly _serviceBrand: undefined;

	/**
	 * Collect FIM context from current editor state. Returns null if no
	 * active text editor is open (e.g. image editor, welcome tab).
	 */
	collect(): FIMContext | null;

	/** Record a recent edit hunk for inclusion in future collections. */
	recordEdit(uri: URI, hunk: string): void;
}

// Max recent edits to retain in the ring buffer.
const MAX_RECENT_EDITS = 10;

// Max open tabs to include (by order in the group).
const MAX_OPEN_TABS = 8;

// Max chars per open-tab snippet.
const TAB_SNIPPET_CHARS = 400;

// Max chars per recent-edit hunk.
const EDIT_HUNK_CHARS = 500;

// Max chars of project rules to include in context.
const MAX_PROJECT_RULES_CHARS = 2000;

// Max chars of AST snippet (surrounding function/class declarations).
const MAX_AST_SNIPPET_CHARS = 800;

// Max chars of skill discoveries digest.
const MAX_SKILL_DISCOVERIES_CHARS = 1000;

// Lines to scan backwards from cursor for AST anchors.
const AST_SCAN_LOOKBACK_LINES = 40;

// Regex anchors that identify a "structural" header line in common languages.
const AST_HEADER_RE = /^(\s*)(export\s+|public\s+|private\s+|protected\s+|static\s+|async\s+|default\s+)*(function|class|interface|type|enum|const|let|var|def|fn|impl|trait|struct|module|namespace|package)\s+[\w$]/;

class VibeFimContextCollector extends Disposable implements IVibeFimContextCollector {
	declare readonly _serviceBrand: undefined;

	private readonly _recentEdits: FIMRecentEdit[] = [];

	constructor(
		@IEditorService private readonly _editorService: IEditorService,
		@IModelService private readonly _modelService: IModelService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
		this._registerEditWatcher();
	}

	private _registerEditWatcher(): void {
		this._register(this._modelService.onModelAdded(model => {
			this._register(model.onDidChangeContent(e => {
				if (e.changes.length === 0) { return; }
				// Build a short unified-diff-style hunk from the first change.
				const change = e.changes[0];
				const hunk = [
					`@@ -${change.range.startLineNumber},${change.range.endLineNumber - change.range.startLineNumber + 1}`,
					change.text ? `+${change.text.slice(0, EDIT_HUNK_CHARS).replace(/\n/g, '\n+')}` : '-[deleted]',
				].join('\n').slice(0, EDIT_HUNK_CHARS);
				this.recordEdit(model.uri, hunk);
			}));
		}));
	}

	recordEdit(uri: URI, hunk: string): void {
		this._recentEdits.unshift({ uri: uri.toString(), timestamp: Date.now(), hunk: hunk.slice(0, EDIT_HUNK_CHARS) });
		if (this._recentEdits.length > MAX_RECENT_EDITS) {
			this._recentEdits.length = MAX_RECENT_EDITS;
		}
	}

	collect(): FIMContext | null {
		const activeEditor = this._editorService.activeTextEditorControl;
		if (!activeEditor || !isCodeEditor(activeEditor)) { return null; }

		const model = activeEditor.getModel();
		if (!model) { return null; }

		const position = activeEditor.getPosition();
		if (!position) { return null; }

		// Build prefix (text before cursor) and suffix (text after cursor)
		const fullText = model.getValue();
		const offset = model.getOffsetAt(position);
		const prefix = fullText.slice(0, offset);
		const suffix = fullText.slice(offset);

		const currentFile: FIMCurrentFile = {
			prefix,
			suffix,
			uri: model.uri.toString(),
			languageId: model.getLanguageId(),
		};

		// Open tabs: collect snippets from visible text models
		const openTabs: FIMOpenTab[] = [];
		for (const editor of this._editorService.visibleTextEditorControls) {
			if (!isCodeEditor(editor)) { continue; }
			const tabModel = editor.getModel();
			if (!tabModel || tabModel.uri.toString() === model.uri.toString()) { continue; }
			const snippet = tabModel.getValue().slice(0, TAB_SNIPPET_CHARS);
			openTabs.push({ uri: tabModel.uri.toString(), languageId: tabModel.getLanguageId(), snippet });
			if (openTabs.length >= MAX_OPEN_TABS) { break; }
		}

		// Project rules (best-effort, sync read from in-memory model if loaded)
		let projectRules: string | undefined;
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const rulesUri = joinPath(folders[0].uri, '.vibe', 'rules.md');
			const rulesModel = this._modelService.getModel(rulesUri);
			if (rulesModel) {
				projectRules = rulesModel.getValue().slice(0, MAX_PROJECT_RULES_CHARS);
			}
		}

		// AST snippet: walk the prefix backwards to the most recent declaration header.
		const astSnippet = this._extractAstSnippet(prefix);

		// Skill discoveries: collect headings from any `.vibe/skills/**/skill.md`
		// model already loaded in memory (best-effort — sync only).
		const skillDiscoveries = this._collectSkillDiscoveries();

		let trimmedContext: FIMContext = {
			currentFile,
			openTabs,
			recentEdits: [...this._recentEdits],
			projectRules,
			astSnippet,
			skillDiscoveries,
		};

		// Apply budget trimming (mirrors the priority order in reportFIMBudget)
		const budgetReport = reportFIMBudget(trimmedContext, FIM_BUDGET_DEFAULTS);
		if (budgetReport.trimmed.includes('skill-discoveries')) {
			trimmedContext = { ...trimmedContext, skillDiscoveries: undefined };
		}
		if (budgetReport.trimmed.includes('ast-snippet')) {
			trimmedContext = { ...trimmedContext, astSnippet: undefined };
		}
		if (budgetReport.trimmed.includes('project-rules')) {
			trimmedContext = { ...trimmedContext, projectRules: undefined };
		}
		if (budgetReport.trimmed.includes('recent-edits')) {
			trimmedContext = { ...trimmedContext, recentEdits: [] };
		}
		if (budgetReport.trimmed.includes('open-tabs')) {
			trimmedContext = { ...trimmedContext, openTabs: [] };
		}
		// If current file still too large, trim it centred on cursor
		const currentFileOver = FIM_BUDGET_DEFAULTS.maxContextChars * FIM_BUDGET_DEFAULTS.minCurrentFileShare;
		if (
			trimmedContext.currentFile.prefix.length + trimmedContext.currentFile.suffix.length > currentFileOver * 2
		) {
			trimmedContext = {
				...trimmedContext,
				currentFile: trimCurrentFileToBudget(trimmedContext.currentFile, Math.floor(currentFileOver * 2)),
			};
		}

		return trimmedContext;
	}

	private _extractAstSnippet(prefix: string): string | undefined {
		if (!prefix) { return undefined; }
		const lines = prefix.split(/\r?\n/);
		const start = Math.max(0, lines.length - AST_SCAN_LOOKBACK_LINES);
		const collected: string[] = [];
		for (let i = lines.length - 1; i >= start; i--) {
			const line = lines[i];
			if (AST_HEADER_RE.test(line)) {
				collected.unshift(line.trim());
				if (collected.join('\n').length >= MAX_AST_SNIPPET_CHARS) { break; }
			}
		}
		if (collected.length === 0) { return undefined; }
		return collected.join('\n').slice(0, MAX_AST_SNIPPET_CHARS);
	}

	private _collectSkillDiscoveries(): string | undefined {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return undefined; }
		const workspaceRoot = folders[0].uri.toString();
		const skillEntries: string[] = [];
		for (const m of this._modelService.getModels()) {
			const uriStr = m.uri.toString();
			if (!uriStr.startsWith(workspaceRoot)) { continue; }
			// Match `.vibe/skills/<name>/skill.md` or `.vibe/skills/<name>.md`.
			if (!/\.vibe\/skills\/[^/]+(\/skill\.md|\.md)$/i.test(uriStr)) { continue; }
			const text = m.getValue();
			const firstHeading = text.match(/^#\s+(.+)$/m)?.[1]?.trim();
			const name = uriStr.split('/').slice(-2, -1)[0] ?? uriStr.split('/').pop() ?? '';
			skillEntries.push(`- ${name}${firstHeading ? `: ${firstHeading}` : ''}`);
		}
		if (skillEntries.length === 0) { return undefined; }
		return skillEntries.join('\n').slice(0, MAX_SKILL_DISCOVERIES_CHARS);
	}
}

registerSingleton(IVibeFimContextCollector, VibeFimContextCollector, InstantiationType.Delayed);
