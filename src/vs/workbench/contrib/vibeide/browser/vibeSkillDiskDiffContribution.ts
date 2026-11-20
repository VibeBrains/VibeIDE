/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { disposableTimeout } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService, FileChangesEvent } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IModelService } from '../../../../editor/common/services/model.js';
import { ILanguageService } from '../../../../editor/common/languages/language.js';
import { skillSnapshotResource, VIBE_SKILL_PREVIOUS_SCHEME } from '../common/skillDiskSnapshot.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/**
 * When workspace `.vibe/skills/` skill markdown files change on disk, show a short summary
 * and offer opening a diff editor (previous snapshot vs current disk), similar in spirit to
 * VibePromptDiffService.
 *
 * Прежний снимок отдаётся только для чтения схемой `vibe-skill-previous:`, справа — сам файл на диске
 * Изменение уже применено, когда приходит уведомление: diff показывает его, а не просит принять
 */
export class VibeSkillDiskDiffContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeSkillDiskDiff';

	private readonly _baseline = new Map<string, string>();
	private readonly _debouncers = new Map<string, IDisposable>();
	/** Прежний текст по файлу: держится только последний снимок, старые не копятся */
	private readonly _snapshots = new Map<string, { resource: string; text: string }>();
	private _snapshotCounter = 0;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IEditorService private readonly _editorService: IEditorService,
		@ITextModelService textModelService: ITextModelService,
		@IModelService private readonly _modelService: IModelService,
		@ILanguageService private readonly _languageService: ILanguageService,
	) {
		super();
		this._register(textModelService.registerTextModelContentProvider(VIBE_SKILL_PREVIOUS_SCHEME, {
			provideTextContent: async resource => {
				const existing = this._modelService.getModel(resource);
				if (existing) {
					return existing;
				}
				const snapshot = [...this._snapshots.values()].find(s => s.resource === resource.toString());
				if (!snapshot) {
					return null;
				}
				return this._modelService.createModel(snapshot.text, this._languageService.createByFilepathOrFirstLine(resource), resource);
			},
		}));
		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this._baseline.clear();
			this._clearDebouncers();
			setTimeout(() => void this._seedBaselineFromDisk(), 400);
		}));
		this._register(this._fileService.onDidFilesChange(e => this._onFilesChange(e)));
		setTimeout(() => void this._seedBaselineFromDisk(), 1200);
	}

	public override dispose(): void {
		this._clearDebouncers();
		super.dispose();
	}

	private _clearDebouncers(): void {
		for (const d of this._debouncers.values()) {
			d.dispose();
		}
		this._debouncers.clear();
	}

	private _isWorkspaceSkillMarkdown(uri: URI): boolean {
		const segments = uri.path.split('/');
		const base = segments[segments.length - 1];
		if (!base) {
			return false;
		}
		const bn = base.toLowerCase();
		const isSkillNamed =
			/^skill(?:\.[a-z0-9-]+)?\.md$/i.test(base)
			|| bn.endsWith('.skill.md');
		if (!isSkillNamed) {
			return false;
		}
		return uri.path.toLowerCase().includes('/.vibe/skills/');
	}

	private _countLineDelta(previous: string, current: string): { additions: number; removals: number } {
		const oldLines = previous.split('\n');
		const newLines = current.split('\n');
		const additions = newLines.filter(l => !oldLines.includes(l) && l.trim()).length;
		const removals = oldLines.filter(l => !newLines.includes(l) && l.trim()).length;
		return { additions, removals };
	}

	private async _seedBaselineFromDisk(): Promise<void> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		for (const folder of folders) {
			const skillsRoot = joinPath(folder.uri, '.vibe', 'skills');
			await this._walkSeed(skillsRoot);
		}
	}

	private async _walkSeed(dir: URI): Promise<void> {
		let stat;
		try {
			stat = await this._fileService.resolve(dir);
		} catch {
			return;
		}
		if (!stat.children?.length) {
			return;
		}
		for (const child of stat.children) {
			if (child.isDirectory) {
				await this._walkSeed(child.resource);
				continue;
			}
			const uri = child.resource;
			if (!this._isWorkspaceSkillMarkdown(uri)) {
				continue;
			}
			try {
				const content = (await this._fileService.readFile(uri)).value.toString();
				this._baseline.set(uri.toString(true), content);
			} catch (err) {
				vibeLog.trace('SkillDiskDiff', 'seed skip', uri.toString(true), err);
			}
		}
	}

	private _onFilesChange(e: FileChangesEvent): void {
		for (const uri of e.rawAdded) {
			if (this._isWorkspaceSkillMarkdown(uri)) {
				void this._captureAdded(uri);
			}
		}
		for (const uri of e.rawUpdated) {
			if (this._isWorkspaceSkillMarkdown(uri)) {
				this._scheduleUpdated(uri);
			}
		}
		for (const uri of e.rawDeleted) {
			if (this._isWorkspaceSkillMarkdown(uri)) {
				this._baseline.delete(uri.toString(true));
			}
		}
	}

	private async _captureAdded(uri: URI): Promise<void> {
		try {
			const content = (await this._fileService.readFile(uri)).value.toString();
			this._baseline.set(uri.toString(true), content);
		} catch {
			// ignore
		}
	}

	private _scheduleUpdated(uri: URI): void {
		const key = uri.toString(true);
		const prev = this._debouncers.get(key);
		if (prev) {
			prev.dispose();
		}
		const handle = disposableTimeout(() => {
			this._debouncers.delete(key);
			void this._handleUpdated(uri);
		}, 700);
		this._debouncers.set(key, handle);
	}

	private async _handleUpdated(uri: URI): Promise<void> {
		const notify = this._configurationService.getValue<boolean>('vibeide.skills.notifyDiskDiff');
		if (notify === false) {
			try {
				const content = (await this._fileService.readFile(uri)).value.toString();
				this._baseline.set(uri.toString(true), content);
			} catch { /* empty */ }
			return;
		}

		const key = uri.toString(true);
		let current: string;
		try {
			current = (await this._fileService.readFile(uri)).value.toString();
		} catch {
			return;
		}

		const previous = this._baseline.get(key);
		if (previous === undefined) {
			this._baseline.set(key, current);
			return;
		}
		if (previous === current) {
			return;
		}

		const { additions, removals } = this._countLineDelta(previous, current);
		this._baseline.set(key, current);

		const basename = uri.path.split('/').pop() ?? uri.path;
		vibeLog.info('SkillDiskDiff', `${basename}: +${additions} −${removals} (approx.)`);

		this._notificationService.notify({
			severity: Severity.Info,
			message: localize('vibeide.skillDiskDiff.updated', "Навык агента обновлён на диске: {0} (примерно +{1} / −{2} строк) — принимать ничего не нужно", basename, additions, removals),
			source: 'VibeIDE',
			actions: {
				primary: [{
					id: 'vibeide.skillDiskDiff.open',
					label: localize('vibeide.skillDiskDiff.openDiff', "Посмотреть изменения"),
					tooltip: localize('vibeide.skillDiskDiff.openDiffTooltip', "Прежняя версия только для чтения рядом с файлом навыка на диске"),
					class: undefined,
					enabled: true,
					run: async () => {
						await this._openDiff(uri, previous, basename);
					},
				}],
			},
		});
	}

	private async _openDiff(uri: URI, oldText: string, basename: string): Promise<void> {
		const original = skillSnapshotResource(uri, String(++this._snapshotCounter));
		this._snapshots.set(uri.toString(), { resource: original.toString(), text: oldText });
		await this._editorService.openEditor({
			original: { resource: original },
			modified: { resource: uri },
			label: localize('vibeide.skillDiskDiff.diffTitle', "{0} — прежняя версия ↔ на диске", basename),
			description: uri.fsPath,
		});
	}
}

registerWorkbenchContribution2(
	VibeSkillDiskDiffContribution.ID,
	VibeSkillDiskDiffContribution,
	WorkbenchPhase.AfterRestored,
);
