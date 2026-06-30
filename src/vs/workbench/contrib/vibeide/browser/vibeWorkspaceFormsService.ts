/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Loads and saves `.vibe` project AI bundle files via IFileService — used by Workspace settings UI.
 * Conflict detection uses the same etag(mtime,size) helper as the rest of the workbench file layer.
 */

import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, etag } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';
import { dirname, joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IVibeProjectRulesService } from './vibeProjectRulesService.js';
import { IVibeSkillsLibraryService, parseSkillMarkdown, serializeSkillMarkdown } from '../common/vibeSkillsLibraryService.js';
import { IVibeConstraintsService } from '../common/vibeConstraintsService.js';

export const MAX_VIBE_RULES_FORM_BYTES = 102400;

/** Stored client-side alongside editor state; compare to fresh stat before save. */
export type VibeWorkspaceFileRevision = string | undefined;

export interface VibeWorkspaceTextLoadResult {
	readonly content: string;
	/** Same contract as IFileService etag(stat); undefined if file absent. */
	readonly revision: VibeWorkspaceFileRevision;
	readonly skippedTooLarge?: boolean;
}

export interface VibeWorkspacePromptListItem {
	readonly name: string;
	readonly preview: string;
	readonly variables: string[];
	readonly revision: VibeWorkspaceFileRevision;
}

export interface VibeWorkspaceWorkflowListItem {
	readonly name: string;
	readonly preview: string;
	readonly stepCount: number;
	readonly revision: VibeWorkspaceFileRevision;
}

export interface VibeWorkspaceSkillListItem {
	readonly folderId: string;
	readonly skillId: string;
	readonly description: string;
	readonly revision: VibeWorkspaceFileRevision;
}

export type VibeWorkspaceSaveResult = 'saved' | 'conflict' | 'too_large';

export const IVibeWorkspaceFormsService = createDecorator<IVibeWorkspaceFormsService>('vibeWorkspaceFormsService');

/** Safe template / folder id segments (parity with slash command resolution conventions). */
const ID_SEGMENT = /^[a-zA-Z0-9._-]+$/;

export function isValidVibeWorkspaceTemplateId(raw: string): boolean {
	const s = raw.trim();
	return s.length > 0 && s.length <= 128 && ID_SEGMENT.test(s) && !s.includes('..');
}

/** Single-segment basename under `.vibe/` (constraints.json, ignore, goals.md, …). */
const ROOT_FILE_BASENAME = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,253}$/;

export function isValidVibeWorkspaceRootBasename(raw: string): boolean {
	const s = raw.trim();
	return s.length > 0 && s.length <= 254 && ROOT_FILE_BASENAME.test(s) && !s.includes('..');
}

/** Shown in Workspace UI — rules.md и goals.md редактируются на отдельных вкладках. */
export const VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP = new Set<string>(['rules.md', 'goals.md']);

export interface VibeWorkspaceRootFileListItem {
	readonly name: string;
	readonly revision: VibeWorkspaceFileRevision;
}

/** Recursive tree under `.vibe/` for quick structure editing (browser UI). */
export interface VibeWorkspaceTreeFileNode {
	readonly kind: 'file';
	readonly name: string;
	readonly relativePath: string;
}

export interface VibeWorkspaceTreeDirNode {
	readonly kind: 'dir';
	readonly name: string;
	readonly relativePath: string;
	readonly children: VibeWorkspaceTreeNode[];
}

export type VibeWorkspaceTreeNode = VibeWorkspaceTreeFileNode | VibeWorkspaceTreeDirNode;

const MAX_VIBE_TREE_DEPTH = 32;

export interface IVibeWorkspaceFormsService {
	readonly _serviceBrand: undefined;

	loadRules(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult>;
	saveRules(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;

	loadAgents(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult>;
	saveAgents(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;

	loadGoals(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult>;
	saveGoals(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;

	listPrompts(workspaceFolder: URI): Promise<VibeWorkspacePromptListItem[]>;
	loadPrompt(workspaceFolder: URI, name: string): Promise<VibeWorkspaceTextLoadResult | null>;
	savePrompt(workspaceFolder: URI, name: string, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;
	deletePrompt(workspaceFolder: URI, name: string): Promise<void>;

	listWorkflows(workspaceFolder: URI): Promise<VibeWorkspaceWorkflowListItem[]>;
	loadWorkflow(workspaceFolder: URI, name: string): Promise<VibeWorkspaceTextLoadResult | null>;
	saveWorkflow(workspaceFolder: URI, name: string, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;
	deleteWorkflow(workspaceFolder: URI, name: string): Promise<void>;
	duplicateWorkflow(workspaceFolder: URI, sourceName: string, newName: string): Promise<'duplicated' | 'exists' | 'not_found'>;

	listSkills(workspaceFolder: URI): Promise<VibeWorkspaceSkillListItem[]>;
	loadSkill(workspaceFolder: URI, folderId: string): Promise<VibeWorkspaceTextLoadResult | null>;
	saveSkill(
		workspaceFolder: URI,
		folderId: string,
		name: string,
		description: string,
		body: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult>;
	createSkill(workspaceFolder: URI, folderId: string, name: string, description: string, body: string): Promise<'created' | 'exists'>;
	deleteSkill(workspaceFolder: URI, folderId: string): Promise<void>;

	duplicatePrompt(workspaceFolder: URI, sourceName: string, newName: string): Promise<'duplicated' | 'exists' | 'not_found'>;

	loadReadme(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult>;
	saveReadme(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult>;

	/** Non-directory files directly under `.vibe/` (JSON, md, ignore, …); excludes names in `VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP`. */
	listVibeRootFiles(workspaceFolder: URI): Promise<VibeWorkspaceRootFileListItem[]>;
	loadVibeRootFile(workspaceFolder: URI, basename: string): Promise<VibeWorkspaceTextLoadResult | null>;
	saveVibeRootFile(
		workspaceFolder: URI,
		basename: string,
		content: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult>;

	/** Full `.vibe/` tree (directories + files), safe path segments only. */
	listVibeTree(workspaceFolder: URI): Promise<VibeWorkspaceTreeNode[]>;
	loadVibeRelativeFile(workspaceFolder: URI, relativePath: string): Promise<VibeWorkspaceTextLoadResult | null>;
	saveVibeRelativeFile(
		workspaceFolder: URI,
		relativePath: string,
		content: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult>;
}

function rulesUri(folder: URI): URI {
	return joinPath(folder, '.vibe', 'rules.md');
}

function agentsUri(folder: URI): URI {
	return joinPath(folder, 'AGENTS.md');
}

function goalsUri(folder: URI): URI {
	return joinPath(folder, '.vibe', 'goals.md');
}

function promptsDir(folder: URI): URI {
	return joinPath(folder, '.vibe', 'prompts');
}

function promptUri(folder: URI, name: string): URI {
	return joinPath(promptsDir(folder), `${name}.md`);
}

function workflowsDir(folder: URI): URI {
	return joinPath(folder, '.vibe', 'workflows');
}

function workflowUri(folder: URI, name: string): URI {
	return joinPath(workflowsDir(folder), `${name}.json`);
}

function skillsRoot(folder: URI): URI {
	return joinPath(folder, '.vibe', 'skills');
}

function skillFolderUri(folder: URI, folderId: string): URI {
	return joinPath(skillsRoot(folder), folderId);
}

function skillMarkdownUri(folder: URI, folderId: string): URI {
	return joinPath(skillFolderUri(folder, folderId), 'SKILL.md');
}

function readmeUri(folder: URI): URI {
	return joinPath(folder, '.vibe', 'README.md');
}

function vibeRootDir(folder: URI): URI {
	return joinPath(folder, '.vibe');
}

function vibeRootFileUri(folder: URI, basename: string): URI {
	return joinPath(vibeRootDir(folder), basename);
}

function isValidVibeRelativePath(relativePath: string): boolean {
	const trimmed = relativePath.trim();
	if (!trimmed || trimmed.startsWith('/') || trimmed.endsWith('/')) {
		return false;
	}
	for (const seg of trimmed.split('/')) {
		if (!isValidVibeWorkspaceRootBasename(seg)) {
			return false;
		}
	}
	return true;
}

function vibeRelativeFileUri(workspaceFolder: URI, relativePath: string): URI | null {
	if (!isValidVibeRelativePath(relativePath)) {
		return null;
	}
	let u = vibeRootDir(workspaceFolder);
	for (const seg of relativePath.split('/')) {
		u = joinPath(u, seg);
	}
	return u;
}

async function revisionOf(fileService: IFileService, uri: URI): Promise<VibeWorkspaceFileRevision> {
	try {
		const stat = await fileService.stat(uri);
		return etag({ mtime: stat.mtime, size: stat.size });
	} catch {
		return undefined;
	}
}

function extractPromptVariables(text: string): string[] {
	const vars = (text.match(/\$[A-Z_][A-Z0-9_]*/g) ?? []).map(v => v.slice(1));
	return [...new Set(vars)];
}

function workflowListMeta(text: string): { preview: string; stepCount: number } {
	try {
		const o = JSON.parse(text) as { description?: string; steps?: unknown[] };
		const desc = typeof o.description === 'string' ? o.description : '';
		const steps = Array.isArray(o.steps) ? o.steps.length : 0;
		const preview = (desc.trim() || '(no description)').slice(0, 200);
		return { preview, stepCount: steps };
	} catch {
		const fallback = text.trim().slice(0, 200);
		return { preview: fallback || 'Invalid JSON', stepCount: 0 };
	}
}

class VibeWorkspaceFormsService extends Disposable implements IVibeWorkspaceFormsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IVibeProjectRulesService private readonly _projectRules: IVibeProjectRulesService,
		@IVibeSkillsLibraryService private readonly _skillsLibrary: IVibeSkillsLibraryService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
	) {
		super();
	}

	private async _loadText(uri: URI, maxBytes: number): Promise<VibeWorkspaceTextLoadResult> {
		const rev = await revisionOf(this._fileService, uri);
		try {
			const stat = await this._fileService.stat(uri);
			if (typeof stat.size === 'number' && stat.size > maxBytes) {
				return { content: '', revision: rev, skippedTooLarge: true };
			}
			const file = await this._fileService.readFile(uri);
			const buffer = file.value;
			if (buffer.byteLength > maxBytes) {
				return { content: '', revision: rev, skippedTooLarge: true };
			}
			const text = buffer.toString();
			return { content: text, revision: rev };
		} catch {
			return { content: '', revision: undefined };
		}
	}

	private async _ensureConflict(uri: URI, expected: VibeWorkspaceFileRevision): Promise<boolean> {
		const current = await revisionOf(this._fileService, uri);
		return current !== expected;
	}

	private async _writeText(uri: URI, content: string, expected: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		if (content.length > MAX_VIBE_RULES_FORM_BYTES) {
			return 'too_large';
		}
		if (await this._ensureConflict(uri, expected)) {
			return 'conflict';
		}
		await this._fileService.writeFile(uri, VSBuffer.fromString(content.replace(/\r\n/g, '\n')));
		return 'saved';
	}

	async loadRules(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult> {
		return this._loadText(rulesUri(workspaceFolder), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveRules(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		const uri = rulesUri(workspaceFolder);
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		const result = await this._writeText(uri, content, expectedRevision);
		if (result === 'saved') {
			await this._projectRules.reloadRules();
		}
		return result;
	}

	async loadAgents(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult> {
		return this._loadText(agentsUri(workspaceFolder), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveAgents(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		const uri = agentsUri(workspaceFolder);
		const result = await this._writeText(uri, content, expectedRevision);
		if (result === 'saved') {
			await this._projectRules.reloadRules();
		}
		return result;
	}

	async loadGoals(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult> {
		return this._loadText(goalsUri(workspaceFolder), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveGoals(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		return this._writeText(goalsUri(workspaceFolder), content, expectedRevision);
	}

	async loadReadme(workspaceFolder: URI): Promise<VibeWorkspaceTextLoadResult> {
		return this._loadText(readmeUri(workspaceFolder), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveReadme(workspaceFolder: URI, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		return this._writeText(readmeUri(workspaceFolder), content, expectedRevision);
	}

	async listPrompts(workspaceFolder: URI): Promise<VibeWorkspacePromptListItem[]> {
		const dir = promptsDir(workspaceFolder);
		let children: Awaited<ReturnType<IFileService['resolve']>>['children'];
		try {
			const resolved = await this._fileService.resolve(dir);
			children = resolved.children;
		} catch {
			return [];
		}
		if (!children?.length) {
			return [];
		}
		const items: VibeWorkspacePromptListItem[] = [];
		for (const c of children) {
			if (c.isDirectory || !c.name.endsWith('.md')) {
				continue;
			}
			const name = c.name.replace(/\.md$/i, '');
			if (!isValidVibeWorkspaceTemplateId(name)) {
				continue;
			}
			try {
				const uri = c.resource;
				const rev = await revisionOf(this._fileService, uri);
				const file = await this._fileService.readFile(uri);
				const text = file.value.toString();
				const preview = text.trim().slice(0, 200);
				items.push({
					name,
					preview,
					variables: extractPromptVariables(text),
					revision: rev,
				});
			} catch { /* skip */ }
		}
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	async loadPrompt(workspaceFolder: URI, name: string): Promise<VibeWorkspaceTextLoadResult | null> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return null;
		}
		return this._loadText(promptUri(workspaceFolder, name), MAX_VIBE_RULES_FORM_BYTES);
	}

	async savePrompt(workspaceFolder: URI, name: string, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return 'conflict';
		}
		if (content.length > MAX_VIBE_RULES_FORM_BYTES) {
			return 'too_large';
		}
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(promptsDir(workspaceFolder));
		const uri = promptUri(workspaceFolder, name);
		return this._writeText(uri, content, expectedRevision);
	}

	async deletePrompt(workspaceFolder: URI, name: string): Promise<void> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return;
		}
		const uri = promptUri(workspaceFolder, name);
		try {
			await this._fileService.del(uri, { recursive: false, useTrash: false });
		} catch { /* absent */ }
	}

	async duplicatePrompt(workspaceFolder: URI, sourceName: string, newName: string): Promise<'duplicated' | 'exists' | 'not_found'> {
		if (!isValidVibeWorkspaceTemplateId(sourceName) || !isValidVibeWorkspaceTemplateId(newName)) {
			return 'not_found';
		}
		const src = promptUri(workspaceFolder, sourceName);
		const dst = promptUri(workspaceFolder, newName);
		let loaded: VibeWorkspaceTextLoadResult;
		try {
			loaded = await this._loadText(src, MAX_VIBE_RULES_FORM_BYTES);
		} catch {
			return 'not_found';
		}
		if (loaded.skippedTooLarge || loaded.revision === undefined) {
			return 'not_found';
		}
		try {
			const dstRev = await revisionOf(this._fileService, dst);
			if (dstRev !== undefined) {
				return 'exists';
			}
		} catch {
			/* dst missing → ok */
		}
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(promptsDir(workspaceFolder));
		await this._fileService.writeFile(dst, VSBuffer.fromString(loaded.content.replace(/\r\n/g, '\n')));
		return 'duplicated';
	}

	async listWorkflows(workspaceFolder: URI): Promise<VibeWorkspaceWorkflowListItem[]> {
		const dir = workflowsDir(workspaceFolder);
		let children: Awaited<ReturnType<IFileService['resolve']>>['children'];
		try {
			const resolved = await this._fileService.resolve(dir);
			children = resolved.children;
		} catch {
			return [];
		}
		if (!children?.length) {
			return [];
		}
		const items: VibeWorkspaceWorkflowListItem[] = [];
		for (const c of children) {
			if (c.isDirectory || !c.name.toLowerCase().endsWith('.json')) {
				continue;
			}
			const name = c.name.replace(/\.json$/i, '');
			if (!isValidVibeWorkspaceTemplateId(name)) {
				continue;
			}
			try {
				const uri = c.resource;
				const rev = await revisionOf(this._fileService, uri);
				const file = await this._fileService.readFile(uri);
				const text = file.value.toString();
				const meta = workflowListMeta(text);
				items.push({
					name,
					preview: meta.preview,
					stepCount: meta.stepCount,
					revision: rev,
				});
			} catch { /* skip */ }
		}
		items.sort((a, b) => a.name.localeCompare(b.name));
		return items;
	}

	async loadWorkflow(workspaceFolder: URI, name: string): Promise<VibeWorkspaceTextLoadResult | null> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return null;
		}
		return this._loadText(workflowUri(workspaceFolder, name), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveWorkflow(workspaceFolder: URI, name: string, content: string, expectedRevision: VibeWorkspaceFileRevision): Promise<VibeWorkspaceSaveResult> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return 'conflict';
		}
		if (content.length > MAX_VIBE_RULES_FORM_BYTES) {
			return 'too_large';
		}
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(workflowsDir(workspaceFolder));
		const uri = workflowUri(workspaceFolder, name);
		return this._writeText(uri, content, expectedRevision);
	}

	async deleteWorkflow(workspaceFolder: URI, name: string): Promise<void> {
		if (!isValidVibeWorkspaceTemplateId(name)) {
			return;
		}
		const uri = workflowUri(workspaceFolder, name);
		try {
			await this._fileService.del(uri, { recursive: false, useTrash: false });
		} catch { /* absent */ }
	}

	async duplicateWorkflow(workspaceFolder: URI, sourceName: string, newName: string): Promise<'duplicated' | 'exists' | 'not_found'> {
		if (!isValidVibeWorkspaceTemplateId(sourceName) || !isValidVibeWorkspaceTemplateId(newName)) {
			return 'not_found';
		}
		const src = workflowUri(workspaceFolder, sourceName);
		const dst = workflowUri(workspaceFolder, newName);
		let loaded: VibeWorkspaceTextLoadResult;
		try {
			loaded = await this._loadText(src, MAX_VIBE_RULES_FORM_BYTES);
		} catch {
			return 'not_found';
		}
		if (loaded.skippedTooLarge || loaded.revision === undefined) {
			return 'not_found';
		}
		try {
			const dstRev = await revisionOf(this._fileService, dst);
			if (dstRev !== undefined) {
				return 'exists';
			}
		} catch {
			/* dst missing → ok */
		}
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(workflowsDir(workspaceFolder));
		await this._fileService.writeFile(dst, VSBuffer.fromString(loaded.content.replace(/\r\n/g, '\n')));
		return 'duplicated';
	}

	async listSkills(workspaceFolder: URI): Promise<VibeWorkspaceSkillListItem[]> {
		const root = skillsRoot(workspaceFolder);
		let children: Awaited<ReturnType<IFileService['resolve']>>['children'];
		try {
			const resolved = await this._fileService.resolve(root);
			children = resolved.children;
		} catch {
			return [];
		}
		if (!children?.length) {
			return [];
		}
		const out: VibeWorkspaceSkillListItem[] = [];
		for (const c of children) {
			if (!c.isDirectory) {
				continue;
			}
			const folderId = c.name;
			if (!isValidVibeWorkspaceTemplateId(folderId)) {
				continue;
			}
			const mdUri = joinPath(c.resource, 'SKILL.md');
			try {
				const file = await this._fileService.readFile(mdUri);
				const text = file.value.toString();
				const rel = `.vibe/skills/${folderId}/SKILL.md`;
				const parsed = parseSkillMarkdown(text, rel, folderId);
				const rev = await revisionOf(this._fileService, mdUri);
				out.push({
					folderId,
					skillId: parsed?.skillId ?? folderId,
					description: parsed?.description ?? '',
					revision: rev,
				});
			} catch { /* skip */ }
		}
		out.sort((a, b) => a.folderId.localeCompare(b.folderId));
		return out;
	}

	async loadSkill(workspaceFolder: URI, folderId: string): Promise<VibeWorkspaceTextLoadResult | null> {
		if (!isValidVibeWorkspaceTemplateId(folderId)) {
			return null;
		}
		return this._loadText(skillMarkdownUri(workspaceFolder, folderId), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveSkill(
		workspaceFolder: URI,
		folderId: string,
		name: string,
		description: string,
		body: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult> {
		if (!isValidVibeWorkspaceTemplateId(folderId)) {
			return 'conflict';
		}
		const trimmedName = name.trim();
		const trimmedDesc = description.trim();
		if (!trimmedName || !trimmedDesc) {
			return 'conflict';
		}
		const md = serializeSkillMarkdown({
			name: trimmedName,
			description: trimmedDesc,
			body,
			vibeVersion: '1.0.0',
		});
		if (md.length > MAX_VIBE_RULES_FORM_BYTES) {
			return 'too_large';
		}
		const uri = skillMarkdownUri(workspaceFolder, folderId);
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(skillsRoot(workspaceFolder));
		await this._fileService.createFolder(skillFolderUri(workspaceFolder, folderId));

		const result = await this._writeText(uri, md, expectedRevision);
		if (result === 'saved') {
			this._skillsLibrary.invalidateCache();
		}
		return result;
	}

	async createSkill(workspaceFolder: URI, folderId: string, name: string, description: string, body: string): Promise<'created' | 'exists'> {
		if (!isValidVibeWorkspaceTemplateId(folderId)) {
			return 'exists';
		}
		const folderUri = skillFolderUri(workspaceFolder, folderId);
		try {
			await this._fileService.resolve(folderUri);
			return 'exists';
		} catch {
			/* ok */
		}
		await this._fileService.createFolder(joinPath(workspaceFolder, '.vibe'));
		await this._fileService.createFolder(skillsRoot(workspaceFolder));
		await this._fileService.createFolder(folderUri);
		const trimmedName = name.trim() || folderId;
		const trimmedDesc = description.trim() || `Skill ${folderId}`;
		const md = serializeSkillMarkdown({
			name: trimmedName,
			description: trimmedDesc,
			body,
			vibeVersion: '1.0.0',
		});
		await this._fileService.writeFile(skillMarkdownUri(workspaceFolder, folderId), VSBuffer.fromString(md.replace(/\r\n/g, '\n')));
		this._skillsLibrary.invalidateCache();
		return 'created';
	}

	async deleteSkill(workspaceFolder: URI, folderId: string): Promise<void> {
		if (!isValidVibeWorkspaceTemplateId(folderId)) {
			return;
		}
		try {
			await this._fileService.del(skillFolderUri(workspaceFolder, folderId), { recursive: true, useTrash: false });
			this._skillsLibrary.invalidateCache();
		} catch { /* noop */ }
	}

	private async _scanVibeSubtree(dirUri: URI, relativePrefix: string, depth: number): Promise<VibeWorkspaceTreeNode[]> {
		if (depth > MAX_VIBE_TREE_DEPTH) {
			return [];
		}
		let rawChildren: NonNullable<Awaited<ReturnType<IFileService['resolve']>>['children']>;
		try {
			const resolved = await this._fileService.resolve(dirUri);
			rawChildren = resolved.children ?? [];
		} catch {
			return [];
		}
		const dirs: VibeWorkspaceTreeDirNode[] = [];
		const files: VibeWorkspaceTreeFileNode[] = [];
		for (const c of rawChildren) {
			const name = c.name;
			if (!isValidVibeWorkspaceRootBasename(name)) {
				continue;
			}
			const rel = relativePrefix ? `${relativePrefix}/${name}` : name;
			if (c.isDirectory) {
				const children = await this._scanVibeSubtree(c.resource, rel, depth + 1);
				dirs.push({ kind: 'dir', name, relativePath: rel, children });
			} else {
				files.push({ kind: 'file', name, relativePath: rel });
			}
		}
		dirs.sort((a, b) => a.name.localeCompare(b.name));
		files.sort((a, b) => a.name.localeCompare(b.name));
		return [...dirs, ...files];
	}

	async listVibeTree(workspaceFolder: URI): Promise<VibeWorkspaceTreeNode[]> {
		return this._scanVibeSubtree(vibeRootDir(workspaceFolder), '', 0);
	}

	async loadVibeRelativeFile(workspaceFolder: URI, relativePath: string): Promise<VibeWorkspaceTextLoadResult | null> {
		const uri = vibeRelativeFileUri(workspaceFolder, relativePath);
		if (!uri) {
			return null;
		}
		try {
			const stat = await this._fileService.stat(uri);
			if (stat.isDirectory) {
				return null;
			}
		} catch {
			return null;
		}
		return this._loadText(uri, MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveVibeRelativeFile(
		workspaceFolder: URI,
		relativePath: string,
		content: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult> {
		const uri = vibeRelativeFileUri(workspaceFolder, relativePath);
		if (!uri) {
			return 'conflict';
		}
		await this._fileService.createFolder(vibeRootDir(workspaceFolder));
		await this._fileService.createFolder(dirname(uri));

		const result = await this._writeText(uri, content, expectedRevision);
		if (result === 'saved') {
			const baseName = relativePath.includes('/') ? relativePath.slice(relativePath.lastIndexOf('/') + 1) : relativePath;
			if (baseName === 'constraints.json' || baseName === 'allowed-models.json') {
				await this._constraints.reload();
			}
		}
		return result;
	}

	async listVibeRootFiles(workspaceFolder: URI): Promise<VibeWorkspaceRootFileListItem[]> {
		const dir = vibeRootDir(workspaceFolder);
		let children: Awaited<ReturnType<IFileService['resolve']>>['children'];
		try {
			const resolved = await this._fileService.resolve(dir);
			children = resolved.children;
		} catch {
			return [];
		}
		if (!children?.length) {
			return [];
		}
		const out: VibeWorkspaceRootFileListItem[] = [];
		for (const c of children) {
			if (c.isDirectory) {
				continue;
			}
			const name = c.name;
			if (!isValidVibeWorkspaceRootBasename(name) || VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP.has(name)) {
				continue;
			}
			try {
				const rev = await revisionOf(this._fileService, c.resource);
				out.push({ name, revision: rev });
			} catch { /* skip */ }
		}
		out.sort((a, b) => a.name.localeCompare(b.name));
		return out;
	}

	async loadVibeRootFile(workspaceFolder: URI, basename: string): Promise<VibeWorkspaceTextLoadResult | null> {
		if (!isValidVibeWorkspaceRootBasename(basename) || VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP.has(basename)) {
			return null;
		}
		return this._loadText(vibeRootFileUri(workspaceFolder, basename), MAX_VIBE_RULES_FORM_BYTES);
	}

	async saveVibeRootFile(
		workspaceFolder: URI,
		basename: string,
		content: string,
		expectedRevision: VibeWorkspaceFileRevision,
	): Promise<VibeWorkspaceSaveResult> {
		if (!isValidVibeWorkspaceRootBasename(basename) || VIBE_WORKSPACE_ROOT_FILE_TAB_SKIP.has(basename)) {
			return 'conflict';
		}
		await this._fileService.createFolder(vibeRootDir(workspaceFolder));
		const uri = vibeRootFileUri(workspaceFolder, basename);
		const result = await this._writeText(uri, content, expectedRevision);
		if (result === 'saved' && (basename === 'constraints.json' || basename === 'allowed-models.json')) {
			await this._constraints.reload();
		}
		return result;
	}
}

registerSingleton(IVibeWorkspaceFormsService, VibeWorkspaceFormsService, InstantiationType.Delayed);
