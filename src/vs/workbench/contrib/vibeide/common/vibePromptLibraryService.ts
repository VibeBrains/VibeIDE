/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { joinPath } from '../../../../base/common/resources.js';

export interface PromptTemplate {
	name: string;      // e.g., "review-security"
	content: string;   // Markdown template with $VARIABLE placeholders
	variables: string[]; // extracted $VARIABLE names
}

export const IVibePromptLibraryService = createDecorator<IVibePromptLibraryService>('vibePromptLibraryService');

export interface IVibePromptLibraryService {
	readonly _serviceBrand: undefined;

	/** Get all available prompts from .vibe/prompts/ */
	getPrompts(): Promise<PromptTemplate[]>;

	/** Get a specific prompt by name */
	getPrompt(name: string): Promise<PromptTemplate | null>;

	/** Render a prompt template with variable values */
	render(templateContent: string, variables: Record<string, string>): string;
}

/**
 * VibeIDE Prompt Library: reads .vibe/prompts/*.md files.
 * Access in chat via /my:template-name
 * Variables: $VARIABLE_NAME in template
 */
class VibePromptLibraryService extends Disposable implements IVibePromptLibraryService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
	) {
		super();
	}

	async getPrompts(): Promise<PromptTemplate[]> {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return []; }

		const promptsDir = joinPath(folders[0].uri, '.vibe', 'prompts');
		try {
			const dir = await this._fileService.resolve(promptsDir);
			if (!dir.children) { return []; }

			const templates: PromptTemplate[] = [];
			for (const child of dir.children) {
				if (!child.name.endsWith('.md')) { continue; }
				try {
					const content = await this._fileService.readFile(child.resource);
					const text = content.value.toString();
					const name = child.name.replace('.md', '');
					const variables = (text.match(/\$[A-Z_][A-Z0-9_]*/g) ?? []).map(v => v.slice(1));
					templates.push({ name, content: text, variables: [...new Set(variables)] });
				} catch { /* skip invalid files */ }
			}
			return templates;
		} catch {
			return [];
		}
	}

	async getPrompt(name: string): Promise<PromptTemplate | null> {
		const prompts = await this.getPrompts();
		return prompts.find(p => p.name === name) ?? null;
	}

	render(templateContent: string, variables: Record<string, string>): string {
		let result = templateContent;
		for (const [key, value] of Object.entries(variables)) {
			result = result.replace(new RegExp(`\\$${key}`, 'g'), value);
		}
		return result;
	}
}

registerSingleton(IVibePromptLibraryService, VibePromptLibraryService, InstantiationType.Delayed);
