/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, IFileStat } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { joinPath, relativePath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { ChatMode } from './vibeideSettingsTypes.js';

export interface VibeSkillEntry {
	/** Slash id: /skill:<skillId> */
	skillId: string;
	/** Human title / first heading */
	title: string;
	/** Short description (frontmatter or first line) */
	description: string;
	/** Full body passed to the model when the skill is invoked */
	body: string;
	/** Workspace-relative path for discovery (.vibe/skills/...) or global-root label */
	relativePath: string;
	/** When true — only `/skill:id` expands full body (roadmap parity). */
	disableModelInvocation?: boolean;
	/** Skill pack: other `/skill:` ids expanded before this skill (acyclic; validated by CLI). */
	depends?: string[];
	version?: string;
	license?: string;
	tags?: string[];
	requiresTools?: string[];
	minVibeide?: string;
	locale?: string;
	/** Skill package format version (YAML `vibeVersion`, migrations / doctor). */
	vibeVersion?: string;
	/** Optional relative path to a validation hook script inside the skill directory (YAML `precheck`). Execution is backlog — validated path-only today. */
	precheck?: string;
	/**
	 * Trigger phrases / keywords that cause implicit skill retrieval.
	 * Format: YAML list or comma-separated string under `triggers:`.
	 * Augments the Jaccard-based implicit retrieval with explicit triggers.
	 */
	triggers?: string[];
	/**
	 * Optional glob pattern to activate this skill only for matching files.
	 * Format: YAML string under `glob:` (e.g. "src/vs/**\/*.ts").
	 * Phase 3b: applied when active editor path matches.
	 */
	glob?: string;
	/** Additional search keywords (beyond description) for implicit retrieval. */
	keywords?: string[];
}

export const IVibeSkillsLibraryService = createDecorator<IVibeSkillsLibraryService>('vibeSkillsLibraryService');

/** Roadmap checklist name alias — discover/list/get are implemented here. */
export type IVibeSkillsService = IVibeSkillsLibraryService;

/** Minimal stopwords for keyword overlap (EN + RU); MVP implicit retrieval. */
const IMPLICIT_SKILL_STOPWORDS = new Set([
	'the', 'and', 'for', 'with', 'this', 'that', 'from', 'your', 'you', 'are', 'was', 'were', 'have', 'has', 'had', 'not', 'but', 'how', 'when', 'what',
	'это', 'эти', 'этот', 'эта', 'что', 'как', 'для', 'или', 'все', 'вас', 'нас', 'они', 'они', 'ли', 'уж', 'мы', 'вы'
]);

function tokenizeSkillText(text: string): Set<string> {
	const words = text.toLowerCase().match(/[\p{L}\p{N}]{3,}/gu) ?? [];
	return new Set(words.filter(w => !IMPLICIT_SKILL_STOPWORDS.has(w)));
}

export interface ImplicitSkillMatch {
	readonly skillId: string;
	readonly score: number;
	readonly title: string;
	readonly description: string;
}

function jaccardTokenSets(a: Set<string>, b: Set<string>): number {
	if (!a.size || !b.size) {
		return 0;
	}
	let inter = 0;
	for (const x of a) {
		if (b.has(x)) {
			inter++;
		}
	}
	const uni = a.size + b.size - inter;
	return uni ? inter / uni : 0;
}

export interface IVibeSkillsLibraryService {
	readonly _serviceBrand: undefined;
	getSkills(): Promise<VibeSkillEntry[]>;
	getSkill(skillId: string): Promise<VibeSkillEntry | null>;
	/** Compact list for GUIDELINES block (discovery); varies by chat mode. */
	getDiscoveryText(chatMode?: ChatMode): Promise<string>;
	/** Keyword overlap ranking over descriptions (MVP implicit retrieval; no cloud embeddings). */
	getImplicitSkillRetrievalHints(userQuery: string, chatMode?: ChatMode): Promise<string>;
	/** Ranked implicit matches (same scoring as hints); for opt-in local audit without cloud. */
	getImplicitSkillRankedMatches(userQuery: string, chatMode?: ChatMode): Promise<readonly ImplicitSkillMatch[]>;
	/** Transitive skill ids in dependency-first order (excludes `skillId`); empty if none / unknown graph. */
	resolveDependencies(skillId: string): Promise<string[]>;
	/** Drops in-memory skill list so the next scan reads disk (file events usually invalidate already). */
	invalidateCache(): void;
	/**
	 * Registers a built-in/bundled skills root (lowest discovery priority — workspace and
	 * globalPaths skills override by id). Used to ship default skills (e.g. `vibe-deploy`).
	 */
	registerBuiltinSkillRoot(root: URI): void;
	/** Record that a skill was just invoked. Persists an MRU list across sessions so
	 * autocomplete can surface frequently-used skills first. Safe to call on every `/skill:` expand. */
	trackSkillUse(skillId: string): void;
	/** Most-recently-used skill ids, newest first. Capped at 20 entries.
	 * Returns just IDs (autocomplete UI cross-references with the full skills list). */
	getRecentSkills(): string[];
}

/** YAML `depends:` as inline `[a,b]` or indented `- id` list (skill ids only). */
export function parseSkillDependsFromFrontmatter(block: string): string[] {
	const lines = block.split(/\r?\n/);
	for (let i = 0; i < lines.length; i++) {
		const line = lines[i];
		const inline = /^\s*depends:\s*\[(.*)]\s*$/.exec(line);
		if (inline) {
			const inner = inline[1].trim();
			if (!inner) {
				return [];
			}
			return inner.split(',').map(s => s.trim().replace(/^["']|["']$/g, '')).filter(Boolean);
		}
		if (/^\s*depends:\s*$/.test(line)) {
			const items: string[] = [];
			let j = i + 1;
			while (j < lines.length) {
				const l = lines[j];
				if (/^\s*-\s+/.test(l)) {
					items.push(l.replace(/^\s*-\s+/, '').trim().replace(/^["']|["']$/g, ''));
					j++;
					continue;
				}
				if (l.trim() === '') {
					j++;
					continue;
				}
				break;
			}
			return items.filter(Boolean);
		}
	}
	return [];
}

/**
 * Topological order: dependencies before dependents. Omits `rootSkillId` from output.
 * Cycles: bail out of the offending branch (best-effort at runtime; CLI validate should catch cycles).
 */
export function orderedTransitiveDependencySkillIds(rootSkillId: string, skills: readonly VibeSkillEntry[]): string[] {
	const byLower = new Map(skills.map(s => [s.skillId.toLowerCase(), s] as const));
	const rootKey = rootSkillId.trim().toLowerCase();
	const root = byLower.get(rootKey);
	if (!root?.depends?.length) {
		return [];
	}
	const ordered: string[] = [];
	const visiting = new Set<string>();
	const visited = new Set<string>();

	const visit = (idRaw: string): void => {
		const k = idRaw.trim().toLowerCase();
		const entry = byLower.get(k);
		if (!entry) {
			return;
		}
		if (visited.has(k)) {
			return;
		}
		if (visiting.has(k)) {
			return;
		}
		visiting.add(k);
		for (const d of entry.depends ?? []) {
			visit(d);
		}
		visiting.delete(k);
		visited.add(k);
		ordered.push(entry.skillId);
	};

	for (const d of root.depends) {
		visit(d.trim());
	}
	return ordered.filter(id => id.toLowerCase() !== rootKey);
}

/** Parse SKILL.md YAML frontmatter (minimal roadmap contract). Invalid strict entries yield null (skipped). */
export function parseSkillMarkdown(raw: string, relativePath: string, defaultId: string): VibeSkillEntry | null {
	let rest = raw.replace(/^\uFEFF/, '');
	let skillId = defaultId;
	let description = '';

	const fm = rest.match(/^---\s*\r?\n([\s\S]*?)\r?\n---\s*\r?\n?/);
	if (fm) {
		const block = fm[1];
		const nameLine = block.match(/^\s*name:\s*(.+)\s*$/m);
		const descLine = block.match(/^\s*description:\s*(.+)\s*$/m);
		const dmiLine = block.match(/^\s*disable-model-invocation:\s*(true|false)\s*$/im);
		const versionLine = block.match(/^\s*version:\s*["']?([^"'\n]+)["']?\s*$/im);
		const licenseLine = block.match(/^\s*license:\s*["']?([^"'\n]+)["']?\s*$/im);
		const localeLine = block.match(/^\s*locale:\s*["']?([^"'\n]+)["']?\s*$/im);
		const minVibeLine = block.match(/^\s*min-vibeide:\s*["']?([^"'\n]+)["']?\s*$/im);
		const vibeVersionLine = block.match(/^\s*vibeVersion:\s*["']?([^"'\n]+)["']?\s*$/im);
		const precheckLine = block.match(/^\s*precheck:\s*(.+)\s*$/im);
		const tagsLine = block.match(/^\s*tags:\s*(.+)\s*$/im);
		const reqToolsLine = block.match(/^\s*requires-tools:\s*\[(.*?)]\s*$/ims)
			?? block.match(/^\s*requires-tools:\s*(.+)\s*$/im);

		if (!nameLine?.[1]?.trim() || !descLine?.[1]?.trim()) {
			return null;
		}
		skillId = nameLine[1].trim().replace(/^["']|["']$/g, '');
		description = descLine[1].trim().replace(/^["']|["']$/g, '');

		let tags: string[] | undefined;
		if (tagsLine?.[1]) {
			const t = tagsLine[1].trim();
			const bracket = /^\[(.*)]$/.exec(t);
			const rawParts = bracket
				? bracket[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
				: t.split(/,\s+/).map(s => s.trim().replace(/^["']|["']$/g, ''));
			tags = rawParts.filter(Boolean);
		}

		let requiresTools: string[] | undefined;
		if (reqToolsLine?.[1]) {
			const inner = reqToolsLine[1].trim();
			const br = /^\[(.*)]$/.exec(inner);
			const rawT = br
				? br[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
				: inner.split(/,\s+/).map(s => s.trim().replace(/^["']|["']$/g, ''));
			requiresTools = rawT.filter(Boolean);
		}

		const dependsParsed = parseSkillDependsFromFrontmatter(block);
		const depends = dependsParsed.length ? dependsParsed : undefined;

		const precheckRaw = precheckLine?.[1]?.trim().replace(/^["']|["']$/g, '');
		const precheck = precheckRaw ? precheckRaw : undefined;

		// Parse triggers, glob, keywords (§ H.2.1 contract additions)
		const triggersLine = block.match(/^\s*triggers:\s*(.+)\s*$/im)
			?? block.match(/^\s*triggers:\s*\[(.*?)]\s*$/ims);
		const globLine = block.match(/^\s*glob:\s*["']?([^"'\n]+)["']?\s*$/im);
		const keywordsLine = block.match(/^\s*keywords:\s*(.+)\s*$/im)
			?? block.match(/^\s*keywords:\s*\[(.*?)]\s*$/ims);

		function parseStringList(raw: string | undefined): string[] | undefined {
			if (!raw?.trim()) { return undefined; }
			const t = raw.trim();
			const bracket = /^\[(.*)]$/.exec(t);
			const parts = bracket
				? bracket[1].split(',').map(s => s.trim().replace(/^["']|["']$/g, ''))
				: t.split(/,\s+/).map(s => s.trim().replace(/^["']|["']$/g, ''));
			return parts.filter(Boolean);
		}

		const triggers = parseStringList(triggersLine?.[1]);
		const glob = globLine?.[1]?.trim();
		const keywords = parseStringList(keywordsLine?.[1]);

		rest = rest.slice(fm[0].length);

		const lines = rest.trim().split(/\r?\n/);
		const titleMatch = lines.find(l => /^#\s+/.test(l.trim()));
		const title = titleMatch ? titleMatch.replace(/^#\s+/, '').trim() : skillId;

		return {
			skillId,
			title,
			description,
			body: rest.trim(),
			relativePath,
			disableModelInvocation: dmiLine ? /^true$/i.test(dmiLine[1].trim()) : undefined,
			version: versionLine?.[1].trim(),
			license: licenseLine?.[1].trim(),
			tags,
			requiresTools,
			depends,
			minVibeide: minVibeLine?.[1].trim(),
			locale: localeLine?.[1].trim(),
			vibeVersion: vibeVersionLine?.[1].trim(),
			precheck,
			triggers,
			glob,
			keywords,
		};
	}

	const lines = rest.trim().split(/\r?\n/);
	const titleMatch = lines.find(l => /^#\s+/.test(l.trim()));
	const title = titleMatch ? titleMatch.replace(/^#\s+/, '').trim() : skillId;
	const firstNonEmpty = lines.map(l => l.trim()).find(l => l && !l.startsWith('#') && !l.startsWith('<!--'));
	description = firstNonEmpty ? firstNonEmpty.slice(0, 200) : `Skill ${skillId}`;

	return {
		skillId,
		title,
		description,
		body: rest.trim(),
		relativePath,
	};
}

/** Build minimal SKILL.md from form fields (`name`/`description` are JSON-quoted for safe YAML scalars). */
export function serializeSkillMarkdown(fields: { name: string; description: string; body: string; vibeVersion?: string }): string {
	const lines: string[] = ['---'];
	lines.push(`name: ${JSON.stringify(fields.name)}`);
	lines.push(`description: ${JSON.stringify(fields.description)}`);
	if (fields.vibeVersion?.trim()) {
		lines.push(`vibeVersion: ${JSON.stringify(fields.vibeVersion.trim())}`);
	}
	lines.push('---');
	lines.push('');
	const body = fields.body.trim();
	return `${lines.join('\n')}\n${body}${body ? '\n' : ''}`;
}

// MRU storage for /skill: autocomplete. Profile scope so the list follows the user
// across workspaces. Capped at 20 to keep the dropdown ordering useful (older entries
// rarely get re-invoked anyway).
const MRU_STORAGE_KEY = 'vibeide.skills.recentIds.v1';
const MRU_CAP = 20;

class VibeSkillsLibraryService extends Disposable implements IVibeSkillsLibraryService {
	declare readonly _serviceBrand: undefined;

	private _cachedSkillsList: VibeSkillEntry[] | undefined;

	/** Bundled/built-in skills roots (URI strings); scanned at lowest discovery priority. */
	private readonly _builtinRoots = new Set<string>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
		@IProductService private readonly _productService: IProductService,
		@IStorageService private readonly _storageService: IStorageService,
	) {
		super();

		this._register(this._configurationService.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.skills.globalPaths')) {
				this.invalidateSkillsCache();
			}
		}));

		this._register(this._workspaceContextService.onDidChangeWorkspaceFolders(() => {
			this.invalidateSkillsCache();
		}));

		this._register(this._fileService.onDidFilesChange(e => {
			const root = this._skillsWorkspaceRoot();
			if (root && e.affects(root)) {
				this.invalidateSkillsCache();
			}
		}));
	}

	private invalidateSkillsCache(): void {
		this._cachedSkillsList = undefined;
	}

	invalidateCache(): void {
		this.invalidateSkillsCache();
	}

	trackSkillUse(skillId: string): void {
		if (!skillId) { return; }
		const current = this.getRecentSkills();
		// Move-to-front: drop any previous occurrence, prepend, cap at MRU_CAP.
		const updated = [skillId, ...current.filter(id => id !== skillId)].slice(0, MRU_CAP);
		try {
			this._storageService.store(MRU_STORAGE_KEY, JSON.stringify(updated), StorageScope.PROFILE, StorageTarget.USER);
		} catch (err) {
			vibeLog.warn('Skills', `Failed to persist MRU list: ${err}`);
		}
	}

	getRecentSkills(): string[] {
		const raw = this._storageService.get(MRU_STORAGE_KEY, StorageScope.PROFILE, '[]');
		try {
			const parsed = JSON.parse(raw);
			if (Array.isArray(parsed)) {
				return parsed.filter((x): x is string => typeof x === 'string').slice(0, MRU_CAP);
			}
		} catch { /* corrupted JSON — fall through to empty */ }
		return [];
	}

	private _truncateSkillText(text: string, maxChars: number): string {
		const t = text.trim();
		if (maxChars <= 0 || t.length <= maxChars) {
			return t;
		}
		return `${t.slice(0, Math.max(0, maxChars - 1))}…`;
	}

	/** When non-empty, discovery / implicit retrieval only sees these skill ids (slash `/skill:` still resolves any skill). */
	private _sessionActiveIdSet(): Set<string> | null {
		const ids = this._configurationService.getValue<string[]>('vibeide.skills.sessionActiveIds')
			?.map(s => (typeof s === 'string' ? s.trim() : ''))
			.filter(Boolean) ?? [];
		if (!ids.length) {
			return null;
		}
		return new Set(ids.map(s => s.toLowerCase()));
	}

	private _filterSkillsForSession(skills: VibeSkillEntry[]): VibeSkillEntry[] {
		const set = this._sessionActiveIdSet();
		if (!set) {
			return skills;
		}
		return skills.filter(s => set.has(s.skillId.toLowerCase()));
	}

	private _skillsWorkspaceRoot(): URI | undefined {
		const f = this._workspaceContextService.getWorkspace().folders[0]?.uri;
		return f ? joinPath(f, '.vibe', 'skills') : undefined;
	}

	async getSkills(): Promise<VibeSkillEntry[]> {
		if (this._cachedSkillsList) {
			return [...this._cachedSkillsList];
		}
		const fresh = await this._mergeAllSkillsFresh();
		this._cachedSkillsList = fresh;
		return [...fresh];
	}

	async resolveDependencies(skillId: string): Promise<string[]> {
		const skills = await this.getSkills();
		return orderedTransitiveDependencySkillIds(skillId, skills);
	}

	registerBuiltinSkillRoot(root: URI): void {
		const key = root.toString();
		if (!this._builtinRoots.has(key)) {
			this._builtinRoots.add(key);
			this.invalidateSkillsCache();
		}
	}

	private async _mergeAllSkillsFresh(): Promise<VibeSkillEntry[]> {
		const byId = new Map<string, VibeSkillEntry>();

		// Built-in/bundled roots first (lowest priority — overridden by globalPaths/workspace below).
		for (const root of this._builtinRoots) {
			try {
				await this._collectSkillsIntoMap(URI.parse(root), byId);
			} catch (e) {
				vibeLog.warn('Skills', 'builtin skills root unreadable:', root, e);
			}
		}

		const globalRoots = this._configurationService.getValue<string[]>('vibeide.skills.globalPaths')
			?.map(s => typeof s === 'string' ? s.trim() : '')
			.filter(Boolean) ?? [];
		for (const p of globalRoots) {
			try {
				await this._collectSkillsIntoMap(URI.file(p), byId);
			} catch (e) {
				vibeLog.warn('Skills', 'globalPaths entry invalid or unreadable:', p, e);
			}
		}

		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			// Primary workspace skills root (.vibe/skills/ — workspace wins over global)
			const skillsRoot = joinPath(folders[0].uri, '.vibe', 'skills');
			await this._collectSkillsIntoMap(skillsRoot, byId);

			// § H.2.1: also scan .cursor/skills/ for Cursor-compatible skill import
			// Priority: .vibe/skills/ already loaded above (workspace-wins rule from globalPaths logic)
			// .cursor/skills/ adds extra skills that don't conflict by id
			const cursorSkillsRoot = joinPath(folders[0].uri, '.cursor', 'skills');
			try {
				await this._collectSkillsIntoMap(cursorSkillsRoot, byId);
			} catch { /* .cursor/skills/ may not exist */ }
		}

		const out = [...byId.values()];
		out.sort((a, b) => a.skillId.localeCompare(b.skillId));
		return out;
	}

	/** SKILL.md or SKILL.<locale>.md (RFC-ish suffix before .md). */
	private _parseSkillPrimaryFilename(name: string): { type: 'base' } | { type: 'localized'; locale: string } | null {
		const m = /^skill(?:\.([a-z0-9-]+))?\.md$/i.exec(name);
		if (!m) {
			return null;
		}
		if (!m[1]) {
			return { type: 'base' };
		}
		return { type: 'localized', locale: m[1].toLowerCase() };
	}

	private _effectiveSkillLocales(): string[] {
		const raw = (this._productService.defaultLocale ?? 'en').trim().toLowerCase().replace(/_/g, '-');
		if (!raw) {
			return ['en'];
		}
		const primary = raw.split('-')[0] || 'en';
		const ordered = raw !== primary ? [raw, primary] : [primary];
		return [...new Set(ordered)];
	}

	private _pickSkillPrimaryFile(files: IFileStat[]): IFileStat | undefined {
		const primaries = files.filter(f => !f.isDirectory && this._parseSkillPrimaryFilename(f.name));
		if (!primaries.length) {
			return undefined;
		}
		for (const loc of this._effectiveSkillLocales()) {
			const hit = primaries.find(f => {
				const p = this._parseSkillPrimaryFilename(f.name);
				return p?.type === 'localized' && p.locale === loc;
			});
			if (hit) {
				return hit;
			}
		}
		const base = primaries.find(f => this._parseSkillPrimaryFilename(f.name)?.type === 'base');
		return base ?? primaries[0];
	}

	private _inferDefaultSkillId(skillUri: URI, filename: string): string {
		const primary = this._parseSkillPrimaryFilename(filename);
		const segs = skillUri.path.split(/[/\\]/);
		const parentDir = segs[segs.length - 2] ?? 'skill';
		if (primary) {
			return parentDir;
		}
		const lower = filename.toLowerCase();
		if (lower.endsWith('.skill.md')) {
			return filename.replace(/\.skill\.md$/i, '').replace(/\.md$/i, '');
		}
		return filename.replace(/\.md$/i, '');
	}

	private async _tryLoadSkillFromChild(child: IFileStat, into: Map<string, VibeSkillEntry>): Promise<void> {
		try {
			const content = await this._fileService.readFile(child.resource);
			const text = content.value.toString();
			const folder = this._workspaceContextService.getWorkspaceFolder(child.resource);
			const rel = folder ? (relativePath(folder.uri, child.resource) ?? child.resource.fsPath) : child.resource.fsPath;
			const defaultId = this._inferDefaultSkillId(child.resource, child.name);
			const parsed = parseSkillMarkdown(text, rel, defaultId);
			if (!parsed) {
				vibeLog.debug('Skills', 'skip (needs name + description when YAML frontmatter present):', child.resource.fsPath);
				return;
			}
			into.set(parsed.skillId.toLowerCase(), parsed);
		} catch (e) {
			vibeLog.debug('Skills', 'skip file', child.resource.fsPath, e);
		}
	}

	/** Loads skills from a directory tree into `into` keyed by lowercase skill id (later roots overwrite earlier). */
	private async _collectSkillsIntoMap(dir: URI, into: Map<string, VibeSkillEntry>): Promise<void> {
		let stat;
		try {
			stat = await this._fileService.resolve(dir);
		} catch {
			return;
		}
		if (!stat.isDirectory || !stat.children) {
			return;
		}
		const dirs: IFileStat[] = [];
		const files: IFileStat[] = [];
		for (const child of stat.children) {
			if (child.isDirectory) {
				dirs.push(child);
			} else {
				files.push(child);
			}
		}

		const primaryPick = this._pickSkillPrimaryFile(files);
		const consumed = new Set<string>();
		if (primaryPick) {
			await this._tryLoadSkillFromChild(primaryPick, into);
			consumed.add(primaryPick.resource.toString(true));
		}

		for (const child of files) {
			if (consumed.has(child.resource.toString(true))) {
				continue;
			}
			if (this._parseSkillPrimaryFilename(child.name)) {
				continue;
			}
			if (!child.name.toLowerCase().endsWith('skill.md')) {
				continue;
			}
			await this._tryLoadSkillFromChild(child, into);
		}

		for (const d of dirs) {
			await this._collectSkillsIntoMap(d.resource, into);
		}
	}

	async getSkill(skillId: string): Promise<VibeSkillEntry | null> {
		const skills = await this.getSkills();
		const key = skillId.trim().toLowerCase();
		return skills.find(s => s.skillId.toLowerCase() === key) ?? null;
	}

	async getDiscoveryText(chatMode: ChatMode = 'normal'): Promise<string> {
		const skills = this._filterSkillsForSession(await this.getSkills());
		if (skills.length === 0) {
			const sess = this._sessionActiveIdSet();
			if (sess?.size) {
				return [
					'## Project Agent Skills — session filter',
					`Discovery is limited to: **${[...sess].join(', ')}** — no matching skills were loaded. Adjust **vibeide.skills.sessionActiveIds** or run **VibeIDE: Skills — select for session**.`,
				].join('\n');
			}
			return '';
		}
		const descCap = Math.max(0, this._configurationService.getValue<number>('vibeide.skills.discoveryDescriptionMaxChars') ?? 600);
		const line = (s: VibeSkillEntry) =>
			`- /skill:${s.skillId} — ${s.title}: ${this._truncateSkillText(s.description, descCap)}`;
		const globalHint =
			this._configurationService.getValue<string[]>('vibeide.skills.globalPaths')
				?.filter(Boolean)?.length ? ' Workspace skills override IDs from **vibeide.skills.globalPaths**.' : '';

		if (chatMode === 'plan') {
			return [
				'## Project Agent Skills — Plan mode',
				'**Do not** execute skill workflows or follow SKILL bodies proactively while planning. Output requirements and a Markdown plan only. Honor a skill only after the user invokes `/skill:id` or approves execution.' + globalHint,
				...skills.map(line),
			].join('\n');
		}

		const proactive = skills.filter(s => !s.disableModelInvocation);
		const explicitOnly = skills.filter(s => s.disableModelInvocation);

		const parts =
			chatMode === 'gather'
				? [
					'## Project Agent Skills (.vibe/skills/**/SKILL.md) — Gather mode',
					'Read-only investigation: you may **cite** relevant skills when suggesting what to read next, but **do not** imply tool execution or file writes from a skill unless the user invoked `/skill:id`.' + globalHint,
					...(proactive.length ? proactive.map(line) : ['_(none — explicit-only skills listed below)_']),
				]
				: [
					'## Project Agent Skills (.vibe/skills/**/SKILL.md)',
					'When a task matches a skill below, you may proactively follow it. The user invokes `/skill:name` to inject the full SKILL body.' + globalHint,
					...(proactive.length ? proactive.map(line) : ['_(none — explicit-only skills listed below)_']),
				];

		if (explicitOnly.length) {
			parts.push(
				'',
				'### Explicit-only (`disable-model-invocation: true`)',
				'Do **not** use these proactively; wait for `/skill:` from the user.',
				...explicitOnly.map(line),
			);
		}

		return parts.join('\n');
	}

	async getImplicitSkillRankedMatches(userQuery: string, chatMode: ChatMode = 'normal'): Promise<readonly ImplicitSkillMatch[]> {
		if (chatMode === 'plan' || chatMode === 'gather') {
			return [];
		}
		const q = userQuery.trim();
		if (q.length < 12) {
			return [];
		}
		const qTokens = tokenizeSkillText(q);
		const skills = this._filterSkillsForSession(await this.getSkills());
		if (qTokens.size < 2) {
			return [];
		}
		const ranked = skills
			.map(s => {
				const corpus = [s.skillId, s.title, s.description, ...(s.tags ?? [])].join('\n');
				return { s, score: jaccardTokenSets(qTokens, tokenizeSkillText(corpus)) };
			})
			.filter(x => x.score >= 0.06)
			.sort((a, b) => b.score - a.score)
			.slice(0, 3);
		return ranked.map(({ s, score }) => ({
			skillId: s.skillId,
			score,
			title: s.title,
			description: s.description,
		}));
	}

	async getImplicitSkillRetrievalHints(userQuery: string, chatMode: ChatMode = 'normal'): Promise<string> {
		const ranked = await this.getImplicitSkillRankedMatches(userQuery, chatMode);
		if (!ranked.length) {
			return '';
		}
		const implicitCap = Math.max(0, this._configurationService.getValue<number>('vibeide.skills.implicitDescriptionMaxChars') ?? 400);
		const lines = ranked.map(r =>
			`- /skill:${r.skillId} — ${r.title}: ${this._truncateSkillText(r.description, implicitCap)} _(keyword score ${r.score.toFixed(2)})_`);
		return [
			'## Implicit skill retrieval (keyword overlap on descriptions)',
			'Suggestion only — use `/skill:id` to load the full SKILL body.',
			...lines,
		].join('\n');
	}
}

registerSingleton(IVibeSkillsLibraryService, VibeSkillsLibraryService, InstantiationType.Delayed);
