/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * VibeProjectRulesService — workspace project rules for AI context.
 *
 * Sources:
 *  - `.vibe/rules.md` (flat file)
 *  - `AGENTS.md` (workspace folder root)
 *  - `.cursorrules` (legacy single-file Cursor convention, for imported projects)
 *  - `.vibe/rules/**\/*.{md,mdc}` and `.cursor/rules/**\/*.mdc` (folder form, Cursor-compatible — R.1).
 *    `.mdc` frontmatter (`description`/`globs`/`alwaysApply`) is stripped from the body.
 *    Before R.1 only the two flat files were read, so Cursor-style rules sitting in a `rules/`
 *    folder were invisible to the model — it then hallucinated filenames (incident 2026-05-30).
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
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { IVibePromptGuardService } from '../common/vibePromptGuardService.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { localize } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { parseRuleFrontmatter, isRuleFileName, parseAlwaysApply, parseTriggers, parseGlobs, decideRuleActivation, ruleNameFromPath } from '../common/prompt/ruleFrontmatter.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface LoadedRuleSource {
	/** Relative path from workspace root */
	relativePath: string;
	/** Content after secret detection (may differ from raw); for `.mdc`, frontmatter already stripped */
	content: string;
	/** Whether secrets were found and redacted */
	wasRedacted: boolean;
	sizeBytes: number;
	// ── Activation metadata (R.7/R.3), parsed from `.mdc` frontmatter; undefined for flat/plain files ──
	/** `true`/`false` when present; `undefined` = plain rule (always injected, back-compat). */
	alwaysApply?: boolean;
	/** Trigger words (lowercased) — inject when the user message contains one. */
	triggers?: readonly string[];
	/** Glob patterns — reserved for R.2 (open-file scoped activation); currently → "available" index. */
	globs?: readonly string[];
	/** `description` frontmatter — shown in the agent-requested "available rules" index. */
	description?: string;
}

export const IVibeProjectRulesService = createDecorator<IVibeProjectRulesService>('vibeProjectRulesService');

export interface IVibeProjectRulesService {
	readonly _serviceBrand: undefined;

	/**
	 * Get the combined AI instructions from all project rules files. Each source is labeled
	 * (`[Source: path]`) and secret-sanitized. With `activation` (the current user message),
	 * conditional rules (triggers/`alwaysApply:false`/globs) are gated: matched → injected,
	 * unmatched → listed in an "available rules" index (R.3/R.7). Without `activation` → inject all.
	 * Returns empty string if no rules files found.
	 */
	getCombinedRules(activation?: { userText?: string; files?: readonly string[] }): string;

	/** Get list of loaded rule sources (for UI preview / settings panel) */
	getLoadedSources(): LoadedRuleSource[];

	/** Look up a loaded rule by its short name (basename without extension) — for `@rule:NAME` (R.5). */
	getRuleByName(name: string): LoadedRuleSource | undefined;

	/** R.4 — per-workspace enable/disable of a rule source (by relativePath). */
	isRuleEnabled(relativePath: string): boolean;
	setRuleEnabled(relativePath: string, enabled: boolean): void;

	/** Force reload all rules files (clears cache) */
	reloadRules(): Promise<void>;

	/** Fired when any rules file changes (to invalidate system message cache) */
	readonly onRulesChanged: Event<void>;
}

// ── Constants ─────────────────────────────────────────────────────────────────

/** Flat rule files to load in order. `.cursorrules` = legacy single-file Cursor convention
 *  (pre-`.mdc`), common in imported projects — treated as a plain always-on rule. */
const RULE_FILE_NAMES = ['.vibe/rules.md', 'AGENTS.md', '.cursorrules'];
/** Folders scanned recursively for `*.md` / `*.mdc` rule files (R.1, Cursor-compatible). */
const RULE_FOLDER_NAMES = ['.vibe/rules', '.cursor/rules'];
const MAX_RULE_FILE_BYTES = 102400; // 100KB per file
/** Cap total folder-discovered rule files so a stray big rules/ tree can't blow the prompt budget. */
const MAX_RULE_FILES = 50;
/** Recursion depth cap for the rules-folder scan. */
const MAX_RULE_FOLDER_DEPTH = 6;
const WATCHER_DEBOUNCE_MS = 350;
/** Workspace-scoped storage of disabled rule source paths (R.4 toggle). */
const DISABLED_STORAGE_KEY = 'vibeide.projectRules.disabledPaths';

// ── Implementation ─────────────────────────────────────────────────────────────

class VibeProjectRulesService extends Disposable implements IVibeProjectRulesService {
	declare readonly _serviceBrand: undefined;

	private _cachedSources: LoadedRuleSource[] = [];
	private _cachedCombined = '';
	/** Rule source paths the user disabled (R.4); honored in `_combineSources`, persisted per workspace. */
	private readonly _disabledPaths = new Set<string>();

	private readonly _onRulesChanged = this._register(new Emitter<void>());
	readonly onRulesChanged: Event<void> = this._onRulesChanged.event;

	private readonly _debouncer = this._register(new RunOnceScheduler(() => {
		this._onRulesChanged.fire();
		this._log.info('[VibeProjectRules] Rules changed, cache invalidated');
	}, WATCHER_DEBOUNCE_MS));

	constructor(
		@ILogService private readonly _log: ILogService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibePromptGuardService private readonly _guard: IVibePromptGuardService,
		@IStorageService private readonly _storage: IStorageService,
	) {
		super();
		// R.4 — restore the per-workspace disabled-rules set.
		try {
			const arr = JSON.parse(this._storage.get(DISABLED_STORAGE_KEY, StorageScope.WORKSPACE, '[]'));
			if (Array.isArray(arr)) { for (const p of arr) { if (typeof p === 'string') { this._disabledPaths.add(p); } } }
		} catch { /* corrupt → empty */ }
		// Watch for file changes in workspace root
		this._register(this._fileService.onDidFilesChange(e => {
			const rootUris = this._workspace.getWorkspace().folders.map(f => f.uri);
			const relevantChange = rootUris.some(root => {
				for (const name of RULE_FILE_NAMES) {
					if (e.contains(joinPath(root, name))) {
						return true;
					}
				}
				// R.1 — any add/change/delete under a rules folder invalidates the cache.
				for (const folder of RULE_FOLDER_NAMES) {
					if (e.affects(joinPath(root, ...folder.split('/')))) {
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

	getCombinedRules(activation?: { userText?: string; files?: readonly string[] }): string {
		// No activation (Settings preview / Ctrl+K / Autocomplete) → inject all (cached, computed
		// in reloadRules). With activation (Chat agent path) → gate conditional rules by user text.
		// Both read from `_cachedSources`; content was loaded async, so this is last-known (the
		// contrib reloads on workspace change + the reload command refreshes).
		if (!activation) { return this._cachedCombined; }
		return this._combineSources(this._cachedSources, activation);
	}

	/**
	 * Combine loaded sources into the prompt block: dedup by content (R.6), label each source
	 * (`[Source: path]`), and — when `activation` is given — gate conditional rules, listing
	 * unmatched ones in an "available rules" index (R.3/R.7). Without `activation` → inject all.
	 */
	private _combineSources(sources: readonly LoadedRuleSource[], activation: { userText?: string; files?: readonly string[] } | undefined): string {
		const seen = new Set<string>();
		const injected: string[] = [];
		const indexed: LoadedRuleSource[] = [];
		for (const s of sources) {
			if (this._disabledPaths.has(s.relativePath)) { continue; } // R.4 — user-disabled
			const body = s.content.trim();
			if (body.length === 0) { continue; }
			if (seen.has(body)) { continue; } // R.6 — dedup identical content across sources
			seen.add(body);
			const act = decideRuleActivation({ alwaysApply: s.alwaysApply, triggers: s.triggers ?? [], globs: s.globs ?? [] }, activation ?? {});
			if (act === 'inject') {
				const label = `[Source: ${s.relativePath}${s.wasRedacted ? ' (secrets redacted)' : ''}]`;
				injected.push(`${label}\n${body}`);
			} else if (activation !== undefined) {
				// Conditional + unmatched: list as "available" ONLY on the agent-chat path (activation
				// provided). No-activation callers (Ctrl+K / Autocomplete / Settings combined view) drop
				// conditional rules entirely — no bloat and no index in narrow completions.
				indexed.push(s);
			}
		}
		const parts: string[] = [];
		if (injected.length > 0) { parts.push(injected.join('\n\n')); }
		if (indexed.length > 0) {
			const list = indexed.map(s => `- ${ruleNameFromPath(s.relativePath)}${s.description ? ` — ${s.description}` : ''}`).join('\n');
			parts.push(`[Available project rules — conditional, not loaded this turn; load with @rule:<name>]\n${list}`);
		}
		return parts.join('\n\n').trim();
	}

	getLoadedSources(): LoadedRuleSource[] {
		return [...this._cachedSources];
	}

	getRuleByName(name: string): LoadedRuleSource | undefined {
		const target = name.trim().toLowerCase();
		if (!target) { return undefined; }
		return this._cachedSources.find(s => ruleNameFromPath(s.relativePath) === target);
	}

	isRuleEnabled(relativePath: string): boolean {
		return !this._disabledPaths.has(relativePath);
	}

	setRuleEnabled(relativePath: string, enabled: boolean): void {
		if (enabled) { this._disabledPaths.delete(relativePath); } else { this._disabledPaths.add(relativePath); }
		this._storage.store(DISABLED_STORAGE_KEY, JSON.stringify([...this._disabledPaths]), StorageScope.WORKSPACE, StorageTarget.USER);
		this._cachedCombined = this._combineSources(this._cachedSources, undefined);
		this._onRulesChanged.fire();
	}

	async reloadRules(): Promise<void> {
		const sources: LoadedRuleSource[] = [];
		const folders = this._workspace.getWorkspace().folders;

		for (const folder of folders) {
			// Load named flat rule files
			for (const name of RULE_FILE_NAMES) {
				const uri = joinPath(folder.uri, ...name.split('/'));
				const source = await this._tryLoadRuleFile(uri, name);
				if (source) { sources.push(source); }
			}
			// R.1 — recursively discover rule files in rules folders (Cursor-compatible).
			for (const folderName of RULE_FOLDER_NAMES) {
				if (sources.length >= MAX_RULE_FILES) { break; }
				const dirUri = joinPath(folder.uri, ...folderName.split('/'));
				const ruleUris = await this._collectFolderRuleUris(dirUri, 0);
				for (const ruleUri of ruleUris) {
					if (sources.length >= MAX_RULE_FILES) {
						this._log.warn(`[VibeProjectRules] Hit MAX_RULE_FILES=${MAX_RULE_FILES}; remaining rule files skipped`);
						break;
					}
					const rel = relativePath(folder.uri, ruleUri) ?? ruleUri.path;
					const source = await this._tryLoadRuleFile(ruleUri, rel);
					if (source) { sources.push(source); }
				}
			}
		}

		this._cachedSources = sources;
		// Cache the "inject all" combine for the no-activation callers (Settings / Ctrl+K / Autocomplete).
		this._cachedCombined = this._combineSources(sources, undefined);

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
			// `.mdc` (Cursor) files carry a leading frontmatter block — strip it; the body is the
			// actual instruction, and the frontmatter feeds activation (alwaysApply/triggers/globs).
			// Plain `.md` is left verbatim (a leading `---` there is content, not frontmatter).
			const parsed = relativePath.toLowerCase().endsWith('.mdc') ? parseRuleFrontmatter(raw) : undefined;
			const effective = parsed ? parsed.body : raw;
			const guardResult = this._guard.sanitizeFileContent(effective, relativePath);
			return {
				relativePath,
				content: guardResult.sanitized,
				wasRedacted: effective !== guardResult.sanitized,
				sizeBytes: effective.length,
				alwaysApply: parsed ? parseAlwaysApply(parsed.frontmatter) : undefined,
				triggers: parsed ? parseTriggers(parsed.frontmatter) : undefined,
				globs: parsed ? parseGlobs(parsed.frontmatter) : undefined,
				description: parsed ? (parsed.frontmatter['description'] || undefined) : undefined,
			};
		} catch {
			return null; // File does not exist or cannot be read
		}
	}

	/**
	 * R.1 — recursively collect `*.md` / `*.mdc` rule files under a folder (Cursor-compatible).
	 * Returns [] when the folder is absent. Depth-capped; children sorted by name for a stable,
	 * deterministic ordering (the model sees rules in the same order every run).
	 */
	private async _collectFolderRuleUris(dirUri: URI, depth: number): Promise<URI[]> {
		if (depth > MAX_RULE_FOLDER_DEPTH) { return []; }
		let stat;
		try {
			stat = await this._fileService.resolve(dirUri);
		} catch {
			return []; // folder doesn't exist — expected, silent
		}
		if (!stat.isDirectory || !stat.children) { return []; }
		const files: URI[] = [];
		const children = [...stat.children].sort((a, b) => a.name.localeCompare(b.name));
		for (const child of children) {
			if (child.isDirectory) {
				files.push(...await this._collectFolderRuleUris(child.resource, depth + 1));
			} else if (isRuleFileName(child.name)) {
				files.push(child.resource);
			}
		}
		return files;
	}
}

registerSingleton(IVibeProjectRulesService, VibeProjectRulesService, InstantiationType.Delayed);

// ── Command: Toggle Project Rule (enable/disable a source) — R.4 ────────────────
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.toggle',
			title: { value: localize('vibeide.projectRules.toggle', 'VibeIDE: Включить/выключить правило проекта'), original: 'VibeIDE: Toggle Project Rule' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const rulesSvc = accessor.get(IVibeProjectRulesService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		await rulesSvc.reloadRules();
		const sources = rulesSvc.getLoadedSources();
		if (sources.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.projectRules.toggle.none', 'Правил проекта не найдено.') });
			return;
		}
		const items: (IQuickPickItem & { path: string })[] = sources.map(s => {
			const on = rulesSvc.isRuleEnabled(s.relativePath);
			return {
				label: `${on ? '$(check)' : '$(circle-slash)'} ${s.relativePath}`,
				description: on ? localize('vibeide.projectRules.toggle.on', 'включено') : localize('vibeide.projectRules.toggle.off', 'выключено'),
				path: s.relativePath,
			};
		});
		const pick = await quickInput.pick(items, { placeHolder: localize('vibeide.projectRules.toggle.placeholder', 'Выберите правило, чтобы включить/выключить') });
		if (!pick) { return; }
		const nowEnabled = !rulesSvc.isRuleEnabled(pick.path);
		rulesSvc.setRuleEnabled(pick.path, nowEnabled);
		notifications.notify({
			severity: Severity.Info,
			message: nowEnabled
				? localize('vibeide.projectRules.toggle.enabled', 'Правило включено: {0}', pick.path)
				: localize('vibeide.projectRules.toggle.disabled', 'Правило выключено: {0}', pick.path),
		});
	}
});

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
			id: 'vibeide.projectRules.addRule',
			title: { value: localize('vibeide.projectRules.addRule', 'VibeIDE: Добавить правило проекта (.vibe/rules.md)'), original: 'VibeIDE: Add Project Rule (.vibe/rules.md)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);
		const rulesSvc = accessor.get(IVibeProjectRulesService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.projectRules.addRule.noFolder', 'Откройте папку проекта, чтобы добавить правило.') });
			return;
		}

		const text = (await quickInput.input({
			prompt: localize('vibeide.projectRules.addRule.prompt', 'Новое правило — будет дописано в .vibe/rules.md'),
			placeHolder: localize('vibeide.projectRules.addRule.ph', 'например: всегда отвечать на русском'),
		}))?.trim();
		if (!text) { return; }

		const uri = joinPath(folder.uri, '.vibe', 'rules.md');
		let existing = '';
		try { existing = (await fileService.readFile(uri)).value.toString(); } catch { /* file does not exist yet — will be created */ }
		const needsHeader = existing.trim().length === 0;
		const prefix = existing.length > 0 && !existing.endsWith('\n') ? '\n' : '';
		const block = `${needsHeader ? '# Project rules\n\n' : ''}${prefix}- ${text}\n`;
		await fileService.writeFile(uri, VSBuffer.fromString(existing + block));
		await rulesSvc.reloadRules();
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.projectRules.addRule.done', 'Правило добавлено в .vibe/rules.md') });
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.projectRules.open',
			title: { value: localize('vibeide.projectRules.open', 'VibeIDE: Открыть правила проекта (.vibe/rules.md)'), original: 'VibeIDE: Open Project Rules (.vibe/rules.md)' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.projectRules.open.noFolder', 'Откройте папку проекта.') });
			return;
		}
		const uri = joinPath(folder.uri, '.vibe', 'rules.md');
		if (!(await fileService.exists(uri))) {
			await fileService.writeFile(uri, VSBuffer.fromString('# Project rules\n\n'));
		}
		await editorService.openEditor({ resource: uri });
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
			? '// No project rules files found.\n// Create: .vibe/rules.md | AGENTS.md | .vibe/rules/*.md(c) | .cursor/rules/*.mdc'
			: sources.map(s => `// ${s.relativePath} (${s.sizeBytes} bytes${s.wasRedacted ? ', secrets redacted' : ''})\n${s.content}`).join('\n\n---\n\n');

		const uri = URI_.parse(`untitled://project-rules-sources-${Date.now()}.md`);
		const modelSvc = accessor.get(ITextModelService);
		const ref = await modelSvc.createModelReference(uri);
		ref.object.textEditorModel?.setValue(content);
		ref.dispose();
		await accessor.get(IEditorService).openEditor({ resource: uri });
	}
});
