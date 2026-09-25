/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Editor action «Нейрослоп в тексте»: the neural-slop detector on the selection, or on the whole file without one.
 *
 * The same check as the agent's `vibe_text_slop_check` and the turn gate — built-in catalogue plus the project's
 * `.vibe/slop.json` — for a person who wants to see a text's tells before an agent does. VibeIDEA has the same action.
 */

import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IProgressService, ProgressLocation } from '../../../../platform/progress/common/progress.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ICodeEditorService } from '../../../../editor/browser/services/codeEditorService.js';
import { EndOfLinePreference } from '../../../../editor/common/model.js';
import { Position } from '../../../../editor/common/core/position.js';
import { Range } from '../../../../editor/common/core/range.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import { IVibeTextSlopService } from '../common/textSlop/vibeTextSlopService.js';
import { SlopFinding } from '../common/textSlop/textSlop.js';
import { slopSeverityRank } from '../common/textSlop/slopCatalog.js';

/** Prose files the action is offered on without a selection — the turn gate's list */
const PROSE_EDITOR = ContextKeyExpr.deserialize('resourceExtname =~ /^\\.(md|mdx|markdown|txt|rst|adoc)$/i');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.textSlop.checkEditor',
			title: localize2('vibeide.textSlop.checkEditor', "Нейрослоп в тексте"),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
			menu: {
				id: MenuId.EditorContext,
				group: '1_modification',
				order: 20,
				when: ContextKeyExpr.and(ContextKeyExpr.deserialize('editorTextFocus'), ContextKeyExpr.or(ContextKeyExpr.deserialize('editorHasSelection'), PROSE_EDITOR)),
			},
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editor = accessor.get(ICodeEditorService).getFocusedCodeEditor() ?? accessor.get(ICodeEditorService).getActiveCodeEditor();
		const slop = accessor.get(IVibeTextSlopService);
		const notifications = accessor.get(INotificationService);
		const progress = accessor.get(IProgressService);
		const quickInput = accessor.get(IQuickInputService);
		const workspace = accessor.get(IWorkspaceContextService);
		if (!editor?.hasModel()) {
			notifications.info(localize('vibeide.textSlop.noEditor', "Откройте текст в редакторе — проверять нечего."));
			return;
		}
		const model = editor.getModel();
		const selection = editor.getSelection();
		const range = selection.isEmpty() ? model.getFullModelRange() : selection;
		// The detector reads '\n' line endings; positions come back in that form, lines and columns match the editor's
		const text = model.getValueInRange(range, EndOfLinePreference.LF);
		const check = await progress.withProgress(
			{ location: ProgressLocation.Window, title: localize('vibeide.textSlop.checking', "Нейрослоп: проверка текста…") },
			() => slop.check(text, workspace.getWorkspaceFolder(model.uri)?.uri),
		);
		if (!check) {
			notifications.warn(localize('vibeide.textSlop.notChecked', "Текст не проверен: каталог примет в этой сборке не читается или проверка не уложилась в срок (vibeide.textSlop.checkTimeoutMs)."));
			return;
		}
		const { report, warnings } = check;
		const verdict = localize('vibeide.textSlop.verdict', "Нейрослоп: {0}/100 (проход — от {1}), {2}", Math.round(report.score * 10) / 10, report.passScore, report.passed ? localize('vibeide.textSlop.passes', "проходит") : localize('vibeide.textSlop.fails', "не проходит"));
		if (report.findings.length === 0) {
			notifications.info(warnings.length > 0 ? `${verdict}. ${warnings.join('; ')}` : verdict);
			return;
		}
		type FindingItem = IQuickPickItem & { readonly finding: SlopFinding };
		const items: FindingItem[] = [...report.findings]
			.sort((a, b) => slopSeverityRank(b.severity) - slopSeverityRank(a.severity) || a.line - b.line || a.column - b.column)
			.map(finding => ({
				finding,
				label: `[${finding.severity}] ${finding.rule} ${finding.name}`,
				description: finding.density
					? localize('vibeide.textSlop.density', "{0} раз, строки {1}", finding.density.count, finding.density.lines.join(', '))
					: localize('vibeide.textSlop.at', "строка {0} — «{1}»", range.startLineNumber + finding.line - 1, finding.match),
				detail: finding.fix || undefined,
			}));
		const picked = await quickInput.pick(items, {
			title: verdict,
			placeHolder: warnings.length > 0 ? warnings.join('; ') : localize('vibeide.textSlop.pick', "Находка — выделить место в тексте"),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		// Line and column of the finding are the checked text's own: shift them to where that text starts in the editor
		const { finding } = picked;
		const line = range.startLineNumber + finding.line - 1;
		const column = finding.line === 1 ? range.startColumn + finding.column - 1 : finding.column;
		const start = model.validatePosition(new Position(line, column));
		const end = model.getPositionAt(model.getOffsetAt(start) + (finding.end - finding.start));
		editor.setSelection(Range.fromPositions(start, end));
		editor.revealRangeInCenterIfOutsideViewport(Range.fromPositions(start, end));
		editor.focus();
	}
});
