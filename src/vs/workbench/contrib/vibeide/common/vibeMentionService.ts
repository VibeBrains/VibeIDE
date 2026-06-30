/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
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

export interface SearchMention {
	/** Literal query string. Empty when user typed `@search` alone (caller should prompt). */
	query: string;
}

export interface IVibeMentionService {
	readonly _serviceBrand: undefined;

	/**
	 * Parse @file, @symbol, @web, @resource, @diagram, @search mentions from chat input.
	 */
	parseMentions(input: string): Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram' | 'search'; value: string }>;

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

	/**
	 * True when user typed `@search …` (workspace literal grep, no LLM, no embeddings).
	 * Distinct from `@web` — search is purely local, web pulls from network.
	 */
	hasSearchMention(input: string): boolean;

	/**
	 * Parse all `@search:<query>` and `@search "query"` mentions. The colon form takes
	 * a single token; the quoted form takes the contents between the next pair of
	 * double quotes.
	 */
	parseSearchMentions(input: string): SearchMention[];
}

/**
 * VibeIDE @file/@symbol Mention Service.
 * Explicit user control over context — @src/utils.ts adds file directly.
 * Complements Smart context picker (auto) with manual override.
 */
class VibeMentionService extends Disposable implements IVibeMentionService {
	declare readonly _serviceBrand: undefined;

	// Patterns: @src/utils.ts, @UserService, @web, @docs, @resource, @diagram, @search
	private readonly FILE_MENTION_RE = /@([\w./\\-]+\.\w+)/g;
	private readonly SYMBOL_MENTION_RE = /@([A-Z][A-Za-z0-9]+)/g;
	private readonly WEB_MENTION_RE = /@(web|docs)\b/i;
	private readonly RESOURCE_MENTION_RE = /@resource\b/i;
	// @diagram or @diagram:path/to/file.png or @diagram:https://figma.com/...
	private readonly DIAGRAM_MENTION_RE = /@diagram(?::([^\s]+))?/gi;
	// `@search:query`, `@search "quoted query"`, or bare `@search`
	private readonly SEARCH_MENTION_RE = /@search(?::([^\s]+)|\s+"([^"]+)")?/gi;

	constructor(
		@IFileService private readonly _fileService: IFileService,
	) {
		super();
	}

	parseMentions(input: string): Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram' | 'search'; value: string }> {
		const mentions: Array<{ type: 'file' | 'symbol' | 'web' | 'resource' | 'diagram' | 'search'; value: string }> = [];
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

		// @search mentions — parse before @file so @search:foo doesn't get split by file regex
		for (const sm of this.parseSearchMentions(input)) {
			const key = `search:${sm.query}`;
			if (!seen.has(key)) {
				seen.add(key);
				mentions.push({ type: 'search', value: sm.query });
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
			vibeLog.warn('Mention', `File not found: ${filePath}`);
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

	hasSearchMention(input: string): boolean {
		const re = new RegExp(this.SEARCH_MENTION_RE.source, 'i');
		return re.test(input);
	}

	parseSearchMentions(input: string): SearchMention[] {
		const results: SearchMention[] = [];
		const re = new RegExp(this.SEARCH_MENTION_RE.source, 'gi');
		let match;
		while ((match = re.exec(input)) !== null) {
			const colonForm = match[1]?.trim() ?? '';
			const quotedForm = match[2]?.trim() ?? '';
			results.push({ query: quotedForm || colonForm });
		}
		return results;
	}
}

registerSingleton(IVibeMentionService, VibeMentionService, InstantiationType.Eager);
