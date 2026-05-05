/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VibeProjectRulesService — workspace project rules for AI context.
 *
 * Sources only:
 *  - `.vibe/rules.md`
 *  - `AGENTS.md` (workspace folder root)
 *
 * Each block is prefixed with `[Source: path]`; content is sanitized via IVibePromptGuardService.
 * File watcher invalidates cache on changes. Command: `vibeide.projectRules.reload`.
 * Global Settings «AI Instructions» are merged elsewhere (not loaded here).
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IVibePromptGuardService } from '../common/vibePromptGuardService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoadedRuleSource {
	/** Relative path from workspace root */
	relativePath: string;
	/** Content after secret detection (may differ from raw) */
	content: string;
	/** Whether secrets were found and redacted */
	wasRedacted: boolean;
	sizeBytes: number;
}

export const IVibeProjectRulesService = createDecorator<IVibeProjectRulesService>('vibeProjectRulesService');

export interface IVibeProjectRulesService {
	readonly _serviceBrand: undefined;

	/**
	 * Get the combined AI instructions from all project rules files.
	 * Each source is labeled. Content is sanitized.
	 * Returns empty string if no rules files found.
	 */
	getCombinedRules(): string;

	/** Get list of loaded rule sources (for UI preview / settings panel) */
	getLoadedSources(): LoadedRuleSource[];

	/** Force reload all rules files (clears cache) */
	reloadRules(): Promise<void>;

	/** Fired when any rules file changes (to invalidate system message cache) */
	readonly onRulesChanged: Event<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Rule files to load in order */
const RULE_FILE_NAMES = ['.vibe/rules.md', 'AGENTS.md'];
const MAX_RULE_FILE_BYTES = 102400; // 100KB per file
const WATCHER_DEBOUNCE_MS = 350;

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeProjectRulesService extends Disposable implements IVibeProjectRulesService {
	declare readonly _serviceBrand: undefined;

	private _cachedSources: LoadedRuleSource[] = [];
	private _cachedCombined = '';
	private _dirty = true;

	private readonly _onRulesChanged = this._register(new Emitter<void>());
	readonly onRulesChanged: Event<void> = this._onRulesChanged.event;

	private readonly _debouncer = this._register(new RunOnceScheduler(() => {
		this._dirty = true;
		this._onRulesChanged.fire();
		this._log.info('[VibeProjectRules] Rules changed, cache invalidated');
	}, WATCHER_DEBOUNCE_MS));

	constructor(
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibePromptGuardService private readonly _guard: IVibePromptGuardService,
	) {
		super();
		// Watch for file changes in workspace root
		this._register(this._fileService.onDidFilesChange(e => {
			const rootUris = this._workspace.getWorkspace().folders.map(f => f.uri);
			const relevantChange = rootUris.some(root => {
				for (const name of RULE_FILE_NAMES) {
					if (e.contains(joinPath(root, name))) {
						return true;
					}
				}
				return false;
			});
			if (relevantChange) {
				this._debouncer.schedule();
			}
		}));
	}

	getCombinedRules(): string {
		if (this._dirty) {
			// Synchronous cache miss — content was loaded async; return last known or empty
			// The caller should call reloadRules() first for fresh content
			return this._cachedCombined;
		}
		return this._cachedCombined;
	}

	getLoadedSources(): LoadedRuleSource[] {
		return [...this._cachedSources];
	}

	async reloadRules(): Promise<void> {
		const sources: LoadedRuleSource[] = [];
		const folders = this._workspace.getWorkspace().folders;

		for (const folder of folders) {
			// Load named rule files
			for (const name of RULE_FILE_NAMES) {
				const uri = joinPath(folder.uri, ...name.split('/'));
				const source = await this._tryLoadRuleFile(uri, name);
				if (source) { sources.push(source); }
			}
		}

		this._cachedSources = sources;

		// Build labeled combined output
		const parts = sources
			.filter(s => s.content.trim().length > 0)
			.map(s => {
				const label = `[Source: ${s.relativePath}${s.wasRedacted ? ' (secrets redacted)' : ''}]`;
				return `${label}\n${s.content}`;
			});

		this._cachedCombined = parts.join('\n\n').trim();
		this._dirty = false;

		this._log.info(`[VibeProjectRules] Loaded ${sources.length} rule sources; combined ${this._cachedCombined.length} chars`);
	}

	private async _tryLoadRuleFile(uri: URI, relativePath: string): Promise<LoadedRuleSource | null> {
		try {
			const stat = await this._fileService.stat(uri);
			if (stat.size > MAX_RULE_FILE_BYTES) {
				this._log.warn(`[VibeProjectRules] Rule file ${relativePath} too large (${stat.size} bytes > ${MAX_RULE_FILE_BYTES}) — truncating`);
			}
			const file = await this._fileService.readFile(uri);
			const raw = file.value.toString().slice(0, MAX_RULE_FILE_BYTES);
			const guardResult = this._guard.sanitizeFileContent(raw, relativePath);
			return {
				relativePath,
				content: guardResult.sanitized,
				wasRedacted: raw !== guardResult.sanitized,
				sizeBytes: raw.length,
			};
		} catch {
			return null; // File does not exist or cannot be read
		}
	}
}

registerSingleton(IVibeProjectRulesService, VibeProjectRulesService, InstantiationType.Delayed);

// ── Command: Reload Project Rules ──────────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.reload',
			title: { value: localize('vibeide.projectRules.reload', 'VibeIDE: Reload Project Rules (force invalidation)'), original: 'VibeIDE: Reload Project Rules (force invalidation)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const rulesSvc = accessor.get(IVibeProjectRulesService);
		const notifications = accessor.get(INotificationService);
		await rulesSvc.reloadRules();
		const sources = rulesSvc.getLoadedSources();
		const combined = rulesSvc.getCombinedRules();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.projectRules.reloaded',
				'Project rules reloaded: {0} sources, {1} chars total.',
				sources.length,
				combined.length
			),
		});
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.showSources',
			title: { value: localize('vibeide.projectRules.showSources', 'VibeIDE: Show Loaded Project Rule Sources'), original: 'VibeIDE: Show Loaded Project Rule Sources' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const rulesSvc = accessor.get(IVibeProjectRulesService);
		if (rulesSvc.getLoadedSources().length === 0) {
			await rulesSvc.reloadRules();
		}
		const sources = rulesSvc.getLoadedSources();
		const { IEditorService } = await import('../../../services/editor/common/editorService.js');
		const { URI: URI_ } = await import('../../../../base/common/uri.js');
		const { ITextModelService } = await import('../../../../editor/common/services/resolverService.js');

		const content = sources.length === 0
			? '// No project rules files found.\n// Create: .vibe/rules.md | AGENTS.md'
			: sources.map(s => `// ${s.relativePath} (${s.sizeBytes} bytes${s.wasRedacted ? ', secrets redacted' : ''})\n${s.content}`).join('\n\n---\n\n');

		const uri = URI_.parse(`untitled://project-rules-sources-${Date.now()}.md`);
		const modelSvc = accessor.get(ITextModelService);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await accessor.get(IEditorService).openEditor({ resource: uri });
	}
});
