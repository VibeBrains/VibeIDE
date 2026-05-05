/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { URI } from '../../../../base/common/uri.js';

export interface MentionedFile {
	filePath: string;
	content?: string;
	symbolName?: string;
	lineRange?: { start: number; end: number };
}

export const IVibeMentionService = createDecorator<IVibeMentionService>('vibeMentionService');

export interface DiagramMention {
	/** Original path or URL from @diagram:<value> */
	value: string;
	/** True if this is a remote URL (FigJam / external) */
	isRemote: boolean;
}

export interface IVibeMentionService {
	readonly _serviceBrand: undefined;

	/**
	 * Parse @file, @symbol, @web, @resource, @diagram mentions from chat input.
	 */
	parseMentions(input: string): Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram'; value: string }>;

	/**
	 * Resolve a @file mention to file content.
	 * Used to explicitly add files to LLM context.
	 */
	resolveFileMention(filePath: string): Promise<MentionedFile | null>;

	/**
	 * Check if input contains @web or @docs mention.
	 * Triggers web search context.
	 */
	hasWebMention(input: string): boolean;

	/** True when user typed @resource (MCP Resources — picker integration backlog). */
	hasResourceMention(input: string): boolean;

	/**
	 * True when user typed @diagram or @diagram:<path>.
	 * Triggers diagram/image attachment to LLM context.
	 */
	hasDiagramMention(input: string): boolean;

	/**
	 * Parse all @diagram:<path> mentions from input.
	 * Handles: @diagram (generic), @diagram:path/to/file.png, @diagram:https://...
	 */
	parseDiagramMentions(input: string): DiagramMention[];
}

/**
 * VibeIDE @file/@symbol Mention Service.
 * Explicit user control over context — @src/utils.ts adds file directly.
 * Complements Smart context picker (auto) with manual override.
 */
class VibeMentionService extends Disposable implements IVibeMentionService {
	declare readonly _serviceBrand: undefined;

	// Patterns: @src/utils.ts, @UserService, @web, @docs, @resource, @diagram
	private readonly FILE_MENTION_RE = /@([\w./\\-]+\.\w+)/g;
	private readonly SYMBOL_MENTION_RE = /@([A-Z][A-Za-z0-9]+)/g;
	private readonly WEB_MENTION_RE = /@(web|docs|search)\b/i;
	private readonly RESOURCE_MENTION_RE = /@resource\b/i;
	// @diagram or @diagram:path/to/file.png or @diagram:https://figma.com/...
	private readonly DIAGRAM_MENTION_RE = /@diagram(?::([^\s]+))?/gi;

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	parseMentions(input: string): Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram'; value: string }> {
		const mentions: Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram'; value: string }> = [];
		const seen = new Set<string>();

		// @diagram mentions — parse first so @diagram:path.png doesn't match as @file
		const diagramMentions = this.parseDiagramMentions(input);
		for (const dm of diagramMentions) {
			const key = `diagram:${dm.value}`;
			if (!seen.has(key)) {
				seen.add(key);
				mentions.push({ type: 'diagram', value: dm.value });
			}
		}

		// @file mentions (skip if already consumed as diagram path)
		let match;
		const fileRe = new RegExp(this.FILE_MENTION_RE.source, 'g');
		while ((match = fileRe.exec(input)) !== null) {
			const v = match[1];
			if (!seen.has(v) && !seen.has(`diagram:${v}`)) {
				seen.add(v);
				mentions.push({ type: 'file', value: v });
			}
		}

		// @web/@docs mentions
		if (this.WEB_MENTION_RE.test(input)) {
			mentions.push({ type: 'web', value: 'web' });
		}

		if (this.RESOURCE_MENTION_RE.test(input)) {
			mentions.push({ type: 'resource', value: 'resource' });
		}

		// @Symbol mentions (uppercase first letter = symbol)
		const symbolRe = new RegExp(this.SYMBOL_MENTION_RE.source, 'g');
		while ((match = symbolRe.exec(input)) !== null) {
			if (!seen.has(match[1]) && !match[1].includes('.')) {
				seen.add(match[1]);
				mentions.push({ type: 'symbol', value: match[1] });
			}
		}

		return mentions;
	}

	async resolveFileMention(filePath: string): Promise<MentionedFile | null> {
		try {
			const uri = URI.file(filePath);
			const content = await this._fileService.readFile(uri);
			return {
				filePath,
				content: content.value.toString().slice(0, 50_000), // max 50KB per mention
			};
		} catch {
			this._logService.warn(`[VibeIDE Mention] File not found: ${filePath}`);
			return null;
		}
	}

	hasWebMention(input: string): boolean {
		return this.WEB_MENTION_RE.test(input);
	}

	hasResourceMention(input: string): boolean {
		return this.RESOURCE_MENTION_RE.test(input);
	}

	hasDiagramMention(input: string): boolean {
		const re = new RegExp(this.DIAGRAM_MENTION_RE.source, 'i');
		return re.test(input);
	}

	parseDiagramMentions(input: string): DiagramMention[] {
		const results: DiagramMention[] = [];
		const re = new RegExp(this.DIAGRAM_MENTION_RE.source, 'gi');
		let match;
		while ((match = re.exec(input)) !== null) {
			const value = match[1]?.trim() ?? '';
			const isRemote = value.startsWith('http://') || value.startsWith('https://') || value.includes('figma.com');
			results.push({ value, isRemote });
		}
		return results;
	}
}

registerSingleton(IVibeMentionService, VibeMentionService, InstantiationType.Eager);
