/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What goes to an external agent together with the person's words: the file open in the editor, the selection, the tabs
 *
 * The agent is a separate process that does not see the editor: asked to «look at the open file», it does not know which
 * one is open. Its prompt takes blocks of content, so the editor's state rides in them
 * What the agent accepts is its own word (`promptCapabilities` of the greeting): the contents of a file go inside the
 * prompt only to an agent that declared `embeddedContext`, the rest get a link and read the file themselves
 *
 * Pure: reading files and the editor's state is up to the caller, who passes the facts in
 */

import { URI } from '../../../../../base/common/uri.js';
import { AcpContentBlock, IAcpCommand, IAcpPromptCapabilities, agentCommandOf } from './acpProtocol.js';

/** Open tabs named in the hint: a long list tells the agent nothing the first twenty do not */
export const ACP_CONTEXT_MAX_TABS = 20;

/** The setting behind the limit below */
export const ACP_EMBED_MAX_CHARS_KEY = 'vibeide.acp.embedMaxChars';

/** Default of `vibeide.acp.embedMaxChars`: a file longer than this goes as a link, not inside the prompt */
export const ACP_EMBED_MAX_CHARS_DEFAULT = 100_000;

/** A piece of the editor the person put into the message, or the editor put there for them */
export type AcpContextItem =
	| { readonly kind: 'selection'; readonly path: string; readonly startLine: number; readonly endLine: number; readonly text: string }
	/** `text` is absent when the file was not read: it is too large, binary or unreadable — the agent gets a link */
	| { readonly kind: 'file'; readonly path: string; readonly text?: string }
	| { readonly kind: 'folder'; readonly path: string };

/** The editor at the moment of sending */
export interface IAcpEditorState {
	readonly activeFile?: string;
	readonly openFiles: readonly string[];
}

export interface IAcpPromptInput {
	/** What the person wrote */
	readonly text: string;
	/** A reminder for the agent that rides ahead of the text (the answer style); dropped before an agent command */
	readonly note?: string;
	/** The agent's own slash commands: a task that starts with one goes as it is */
	readonly commands: readonly IAcpCommand[];
	readonly capabilities: IAcpPromptCapabilities;
	/** The largest file or selection that goes inside the prompt; a longer one goes as a link */
	readonly embedMaxChars: number;
	readonly items: readonly AcpContextItem[];
	readonly editor?: IAcpEditorState;
	/** Masks the secrets in the text that leaves the machine */
	readonly redact: (text: string) => string;
	/** A path closed to the agent (`.vibe/ignore`): neither its contents nor its name go into the prompt */
	readonly isHidden?: (path: string) => boolean;
}

/**
 * The blocks of the prompt
 * A task that starts with an agent command goes alone: the agent reads the command from the first word, and a hint
 * or a note ahead of it would turn the command into plain text
 */
export function buildAcpPromptBlocks(input: IAcpPromptInput): AcpContentBlock[] {
	if (agentCommandOf(input.text, input.commands)) {
		return [{ type: 'text', text: input.text }];
	}
	const isHidden = input.isHidden ?? (() => false);
	const blocks: AcpContentBlock[] = [];

	const hint = input.editor ? editorHint(input.editor, isHidden) : undefined;
	if (hint) {
		blocks.push({ type: 'text', text: hint });
	}
	blocks.push({ type: 'text', text: input.note ? `${input.note}\n\n${input.text}` : input.text });
	for (const item of input.items) {
		if (isHidden(item.path)) { continue; }
		blocks.push(...blocksOfItem(item, input));
	}
	return blocks;
}

/** The active file and the open tabs as a text block; `undefined` when the editor has nothing open */
function editorHint(editor: IAcpEditorState, isHidden: (path: string) => boolean): string | undefined {
	const active = editor.activeFile && !isHidden(editor.activeFile) ? editor.activeFile : undefined;
	const tabs = editor.openFiles.filter(path => !isHidden(path));
	if (!active && tabs.length === 0) { return undefined; }
	const shown = tabs.slice(0, ACP_CONTEXT_MAX_TABS);
	const more = tabs.length - shown.length;
	return [
		'<ide_context>',
		'The editor at the moment this message was written:',
		`- Active file: ${active ?? 'none'}`,
		shown.length > 0 ? `- Open tabs:\n${shown.join('\n')}${more > 0 ? `\n... and ${more} more` : ''}` : '- Open tabs: none',
		'</ide_context>',
	].join('\n');
}

function blocksOfItem(item: AcpContextItem, input: IAcpPromptInput): AcpContentBlock[] {
	switch (item.kind) {
		case 'selection': return [selectionBlock(item, input)];
		case 'file': return [fileBlock(item, input)];
		case 'folder': return [{ type: 'resource_link', uri: fileUri(item.path), name: `${baseName(item.path)}/` }];
	}
}

/**
 * The selection is the point of attaching it, so it does not shrink to a link when the agent cannot take embedded
 * contents: it goes as text. Only a selection too long for the prompt is left to the agent to read by its range
 */
function selectionBlock(item: Extract<AcpContextItem, { kind: 'selection' }>, input: IAcpPromptInput): AcpContentBlock {
	const uri = `${fileUri(item.path)}#L${item.startLine}-${item.endLine}`;
	if (item.text.length > input.embedMaxChars) {
		return { type: 'resource_link', uri, name: `${baseName(item.path)}:${item.startLine}-${item.endLine}` };
	}
	const text = input.redact(item.text);
	if (input.capabilities.embeddedContext) {
		return { type: 'resource', resource: { uri, text } };
	}
	return { type: 'text', text: `Selection in ${item.path} (lines ${item.startLine}-${item.endLine}):\n\`\`\`\n${text}\n\`\`\`` };
}

function fileBlock(item: Extract<AcpContextItem, { kind: 'file' }>, input: IAcpPromptInput): AcpContentBlock {
	const uri = fileUri(item.path);
	if (input.capabilities.embeddedContext && item.text !== undefined && item.text.length <= input.embedMaxChars) {
		return { type: 'resource', resource: { uri, text: input.redact(item.text) } };
	}
	return { type: 'resource_link', uri, name: baseName(item.path) };
}

const fileUri = (path: string): string => URI.file(path).toString();

/** The last segment of a path in either separator style */
const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path;
