/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { localize, localize2 } from '../../../../nls.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { Extensions as ConfigurationExtensions, IConfigurationRegistry } from '../../../../platform/configuration/common/configurationRegistry.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeModalService } from '../common/vibeModalService.js';
import {
	applyVibeDefaults,
	diffVibeDefaults,
	recordVibeDefaultsReconciled,
	VibeDefaultsDiff,
	VibeDefaultsDiffEntry,
} from '../common/vibeDefaults.js';
import { VibeDefaultsContentProvider } from './vibeDefaultsContentProvider.js';

export const VIBEIDE_APPLY_DEFAULTS_CMD = 'vibeide.defaults.apply';
export const VIBEIDE_SHOW_DEFAULTS_CMD = 'vibeide.defaults.show';

/** Whether to say anything when a release moved a `.vibe` file. User-facing → a setting, not a hidden key. */
export const VIBEIDE_ENV_NOTIFY_SETTING = 'vibeide.environment.notifyOnRelease';

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide.environment',
	title: localize('vibeide.environment.title', 'VibeIDE — Окружение агентов (.vibe)'),
	type: 'object',
	properties: {
		[VIBEIDE_ENV_NOTIFY_SETTING]: {
			type: 'boolean',
			default: true,
			description: localize('vibeide.environment.notifyOnRelease.desc', 'Сообщать при открытии проекта, если новый релиз изменил файлы окружения `.vibe`. Уведомление появляется ТОЛЬКО когда сдвинулся релиз: файлы, которые вы правили сами, не считаются поводом — иначе оно напоминало бы о ваших же правках при каждом запуске.'),
		},
	},
});

/** How many paths to list per group before collapsing into «и ещё N» — keeps the modal readable. */
const MAX_LISTED = 12;

const category = { value: 'VibeIDE', original: 'VibeIDE' } as const;

function vibeDirOf(accessor: ServicesAccessor): URI | undefined {
	const folders = accessor.get(IWorkspaceContextService).getWorkspace().folders;
	if (folders.length === 0) {
		accessor.get(INotificationService).notify({
			severity: Severity.Warning,
			message: localize('vibeide.defaults.noWorkspace', 'Откройте папку проекта — окружение живёт в `.vibe` рабочей области.'),
		});
		return undefined;
	}
	return joinPath(folders[0].uri, '.vibe');
}

function listPaths(entries: readonly VibeDefaultsDiffEntry[]): string {
	const shown = entries.slice(0, MAX_LISTED).map(e => `- \`${e.path}\``);
	if (entries.length > MAX_LISTED) {
		shown.push(localize('vibeide.defaults.more', '- …и ещё {0}', entries.length - MAX_LISTED));
	}
	return shown.join('\n');
}

/** Files a human has to look at: both sides moved, or we have no record of a reconciliation. */
function needsHuman(diff: VibeDefaultsDiff): readonly VibeDefaultsDiffEntry[] {
	return [...diff.conflict, ...diff.unknown];
}

/** Markdown report shared by both commands — one description of the state, two entry points. */
function renderReport(diff: VibeDefaultsDiff): string {
	// Don't claim the copy «may have fallen behind» when it demonstrably has not — a report that
	// cries wolf on a healthy environment teaches the user to skip reading it.
	const parts: string[] = [
		diff.needsAttention
			? localize('vibeide.defaults.report.intro', 'Окружение агентов (`.vibe`) развивается от релиза к релизу: добавляются и правятся скиллы, правила и примеры. Ваша копия отстала — ниже видно, в чём.')
			: localize('vibeide.defaults.report.introOk', 'Окружение агентов (`.vibe`) в порядке: всё, что изменил релиз, у вас уже есть. Обновлять нечего.'),
	];

	if (diff.missing.length > 0) {
		parts.push(localize('vibeide.defaults.report.missing', '## Новое в релизе ({0})\n\nЭтих файлов у вас нет.\n\n{1}', diff.missing.length, listPaths(diff.missing)));
	}
	if (diff.outdated.length > 0) {
		parts.push(localize('vibeide.defaults.report.outdated', '## Релиз обновил ({0})\n\nЭти файлы изменились в релизе, а вы их **не трогали** — обновление безопасно, терять нечего.\n\n{1}', diff.outdated.length, listPaths(diff.outdated)));
	}
	if (diff.conflict.length > 0) {
		parts.push(localize('vibeide.defaults.report.conflict', '## Разошлись обе стороны ({0})\n\nИ вы правили файл, и релиз его изменил. Решать вам — посмотрите различия.\n\n{1}', diff.conflict.length, listPaths(diff.conflict)));
	}
	if (diff.unknown.length > 0) {
		parts.push(localize('vibeide.defaults.report.unknown', '## Не сверялось ({0})\n\nФайл отличается от релиза, но сверки не было (окружение создано до того, как появился учёт). Кто менял — неизвестно. Посмотрите различия и решите; после этого файл перестанет попадать в этот список.\n\n{1}', diff.unknown.length, listPaths(diff.unknown)));
	}
	if (diff.customized.length > 0) {
		parts.push(localize('vibeide.defaults.report.customized', '## Ваши файлы ({0})\n\nОтличаются от релиза по вашему решению, релиз их с тех пор не менял. **Трогать не будем** и напоминать о них — тоже.\n\n{1}', diff.customized.length, listPaths(diff.customized)));
	}

	// Label-style «X: N», not «N файлов» — Russian numeral agreement (1 файл / 2 файла / 5 файлов)
	// would need plural forms nls.localize does not have, and «файлов» is wrong for 1 and 2–4.
	parts.push(localize('vibeide.defaults.report.same', 'Файлов, совпадающих с релизом (в порядке, трогать нечего): {0}.', diff.same.length));
	return parts.join('\n\n');
}

/** Opens a diff per file: release version (read-only, `vibe-default:`) ⇄ the workspace copy. */
async function openDiffs(editorService: IEditorService, vibeDir: URI, entries: readonly VibeDefaultsDiffEntry[]): Promise<void> {
	for (const entry of entries.slice(0, MAX_LISTED)) {
		await editorService.openEditor({
			original: { resource: VibeDefaultsContentProvider.toResource(entry.path) },
			modified: { resource: joinPath(vibeDir, ...entry.path.split('/')) },
			label: localize('vibeide.defaults.diffLabel', '{0} — релиз ⇄ ваш', entry.path),
			options: { pinned: false },
		});
	}
}

/**
 * «Показать новое в окружении из релиза» — read-only. Answers «что изменилось с тех пор, как я
 * завёл проект» without touching a byte.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_SHOW_DEFAULTS_CMD,
			title: localize2('vibeide.defaults.show', 'VibeIDE: Показать новое в окружении из релиза'),
			category,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Capture services synchronously before any await (ServicesAccessor lifetime rule).
		const fileService = accessor.get(IFileService);
		const modal = accessor.get(IVibeModalService);
		const editorService = accessor.get(IEditorService);
		const vibeDir = vibeDirOf(accessor);
		if (!vibeDir) {
			return;
		}

		const diff = await diffVibeDefaults(fileService, vibeDir);
		const diffable = [...needsHuman(diff), ...diff.customized, ...diff.outdated];
		const res = await modal.showModal<'diffs' | 'close'>({
			title: localize('vibeide.defaults.show.title', 'Новое в окружении из релиза'),
			body: renderReport(diff),
			bodyMarkdown: true,
			icon: 'diff',
			size: 'large',
			buttons: diffable.length > 0
				? [
					{ id: 'diffs', label: localize('vibeide.defaults.showDiffs', 'Показать различия'), role: 'primary' },
					{ id: 'close', label: localize('vibeide.defaults.close', 'Закрыть'), role: 'secondary' },
				]
				: [{ id: 'close', label: localize('vibeide.defaults.close', 'Закрыть'), role: 'primary' }],
		});
		if (res.buttonId === 'diffs') {
			await openDiffs(editorService, vibeDir, diffable);
		}
	}
});

/**
 * «Обновить окружение из релиза» — shows the report, then acts:
 *   «Обновить безопасно» → add `missing` + rewrite `outdated` (files the user never touched). Cannot
 *                          lose an edit, so it is the primary.
 *   «Показать различия»  → diff editors; merging by hand is the only honest «merge» for arbitrary
 *                          markdown/JSON.
 *   «Оставить своё»      → records a reconciliation point at the CURRENT state, which is what stops a
 *                          file the user deliberately customized from asking again forever.
 *   «Заменить всё»       → overwrite everything; the only path that repairs a stale seeded file the
 *                          user has also edited, and the only one that can discard their work.
 */
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_APPLY_DEFAULTS_CMD,
			title: localize2('vibeide.defaults.apply', 'VibeIDE: Обновить окружение из релиза'),
			category,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const notificationService = accessor.get(INotificationService);
		const modal = accessor.get(IVibeModalService);
		const editorService = accessor.get(IEditorService);
		const vibeDir = vibeDirOf(accessor);
		if (!vibeDir) {
			return;
		}

		let diff: VibeDefaultsDiff;
		try {
			await fileService.createFolder(vibeDir);
			diff = await diffVibeDefaults(fileService, vibeDir);
		} catch (e) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('vibeide.defaults.readFail', 'Не удалось прочитать окружение `.vibe`: {0}', String(e)),
			});
			return;
		}

		const human = needsHuman(diff);
		const safeCount = diff.missing.length + diff.outdated.length;
		if (!diff.needsAttention) {
			notificationService.notify({
				severity: Severity.Info,
				message: localize('vibeide.defaults.alreadyCurrent', 'Окружение `.vibe` в актуальном состоянии — обновлять нечего.'),
			});
			return;
		}

		type Btn = 'safe' | 'diffs' | 'keep' | 'replace' | 'cancel';
		const buttons: { id: Btn; label: string; role: 'primary' | 'secondary' }[] = [];
		if (safeCount > 0) {
			buttons.push({ id: 'safe', label: localize('vibeide.defaults.safe', 'Обновить безопасно ({0})', safeCount), role: 'primary' });
		}
		if (human.length > 0) {
			buttons.push({ id: 'diffs', label: localize('vibeide.defaults.showDiffs', 'Показать различия'), role: buttons.length === 0 ? 'primary' : 'secondary' });
			buttons.push({ id: 'keep', label: localize('vibeide.defaults.keep', 'Оставить своё ({0})', human.length), role: 'secondary' });
		}
		buttons.push({ id: 'cancel', label: localize('vibeide.defaults.cancel', 'Отмена'), role: 'secondary' });

		const res = await modal.showModal<Btn>({
			title: localize('vibeide.defaults.apply.title', 'Обновить окружение из релиза'),
			body: renderReport(diff),
			bodyMarkdown: true,
			icon: 'cloud-download',
			size: 'large',
			buttons,
			// Destructive — kept away from the safe actions on the opposite side of the footer.
			footerLeftButton: { id: 'replace', label: localize('vibeide.defaults.replace', 'Заменить всё'), role: 'secondary' },
		});

		try {
			switch (res.buttonId) {
				case 'diffs':
					await openDiffs(editorService, vibeDir, human);
					return;

				case 'keep': {
					await recordVibeDefaultsReconciled(fileService, vibeDir, human.map(e => e.path));
					notificationService.notify({
						severity: Severity.Info,
						message: localize('vibeide.defaults.kept', 'Отмечено как разобранное: {0}. Эти файлы больше не будут напоминать о себе, пока их не изменит следующий релиз.', human.length),
					});
					return;
				}

				case 'safe': {
					const added = await applyVibeDefaults(fileService, vibeDir, { only: diff.missing.map(e => e.path) });
					const updated = await applyVibeDefaults(fileService, vibeDir, { overwrite: true, only: diff.outdated.map(e => e.path) });
					notificationService.notify({
						severity: Severity.Info,
						message: localize('vibeide.defaults.safeDone', 'Окружение `.vibe` обновлено: добавлено {0}, обновлено {1}. Ваши правки не тронуты.', added.created, updated.created),
					});
					return;
				}

				case 'replace': {
					const atRisk = diff.conflict.length + diff.unknown.length + diff.customized.length;
					if (atRisk > 0) {
						const confirm = await modal.showModal<'yes' | 'no'>({
							title: localize('vibeide.defaults.replace.title', 'Заменить всё?'),
							body: localize('vibeide.defaults.replace.body', 'Файлов с вашими изменениями: **{0}**. Они будут перезаписаны версией из релиза, правки пропадут безвозвратно.\n\nЕсли не уверены — «Отмена», затем «Показать различия».', atRisk),
							bodyMarkdown: true,
							icon: 'warning',
							size: 'small',
							buttons: [
								{ id: 'no', label: localize('vibeide.defaults.replace.no', 'Отмена'), role: 'primary' },
								{ id: 'yes', label: localize('vibeide.defaults.replace.yes', 'Заменить'), role: 'secondary' },
							],
						});
						if (confirm.buttonId !== 'yes') {
							return;
						}
					}
					const result = await applyVibeDefaults(fileService, vibeDir, { overwrite: true });
					notificationService.notify({
						severity: Severity.Info,
						message: localize('vibeide.defaults.replaced', 'Окружение `.vibe` заменено версией из релиза: перезаписано {0}.', result.created),
					});
					return;
				}

				default:
					return; // cancel / ESC
			}
		} catch (e) {
			notificationService.notify({
				severity: Severity.Error,
				message: localize('vibeide.defaults.applyFail', 'Не удалось обновить окружение `.vibe`: {0}', String(e)),
			});
		}
	}
});
