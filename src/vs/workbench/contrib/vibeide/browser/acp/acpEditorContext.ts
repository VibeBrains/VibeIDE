/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What of the editor goes to an external agent with the person's message
 *
 * Reads the services the pure `acpPromptContext` must not touch: the staged files and selections of the composer, the
 * selection in the editor in focus, the open tabs. The decisions — what rides inside the prompt and what goes as a link
 * — are made there; this collects the facts
 */

import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { isCodeEditor, isDiffEditor } from '../../../../../editor/browser/editorBrowser.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { IFileService } from '../../../../../platform/files/common/files.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { AcpContextItem } from '../../common/acp/acpPromptContext.js';
import { StagingSelectionItem } from '../../common/chatThreadServiceTypes.js';
import { IVibeIgnoreService } from '../vibeIgnoreService.js';
import { editorWorkingSet } from '../editorWorkingSet.js';
import { IVibeAcpPromptRequest } from './vibeAcpSessionsService.js';

export interface IAcpEditorContextServices {
	readonly editorService: IEditorService;
	readonly modelService: IModelService;
	readonly fileService: IFileService;
	readonly ignore: IVibeIgnoreService;
}

/** UTF-8 takes up to four bytes a character: the read limit is in bytes, the setting in characters */
const MAX_BYTES_PER_CHAR = 4;

export async function collectAcpEditorContext(
	services: IAcpEditorContextServices,
	selections: readonly StagingSelectionItem[],
	embed: { readonly canEmbed: boolean; readonly maxChars: number },
): Promise<NonNullable<IVibeAcpPromptRequest['context']>> {
	const { editorService, modelService, fileService, ignore } = services;

	/** The text as the person sees it: an open editor with its unsaved edits first, then the disk; too large or unreadable — undefined */
	const textOf = async (uri: URI): Promise<string | undefined> => {
		const model = modelService.getModel(uri);
		if (model) { return model.getValue(); }
		try {
			return (await fileService.readFile(uri, { limits: { size: embed.maxChars * MAX_BYTES_PER_CHAR } })).value.toString();
		} catch {
			return undefined;
		}
	};

	const items: AcpContextItem[] = [];
	for (const selection of selections) {
		if (selection.uri.scheme !== Schemas.file) { continue; }
		const path = selection.uri.fsPath;
		switch (selection.type) {
			case 'File':
				// A link needs no contents: an agent that cannot take them, or a file that is too large, is not read for nothing
				items.push(embed.canEmbed ? { kind: 'file', path, text: await textOf(selection.uri) } : { kind: 'file', path });
				break;
			case 'CodeSelection': {
				const text = await textOf(selection.uri);
				const [startLine, endLine] = selection.range;
				if (text !== undefined) {
					items.push({ kind: 'selection', path, startLine, endLine, text: text.split('\n').slice(startLine - 1, endLine).join('\n') });
				}
				break;
			}
			case 'Folder':
				items.push({ kind: 'folder', path });
				break;
		}
	}

	// The selection in the editor in focus goes along even if the person did not stage it: «look at this» means it
	const control = editorService.activeTextEditorControl;
	const editor = isCodeEditor(control) ? control : isDiffEditor(control) ? control.getModifiedEditor() : undefined;
	const model = editor?.getModel();
	const selected = editor?.getSelection();
	if (model && selected && !selected.isEmpty() && model.uri.scheme === Schemas.file) {
		const startLine = selected.startLineNumber;
		const endLine = selected.endColumn === 1 && selected.endLineNumber > startLine ? selected.endLineNumber - 1 : selected.endLineNumber;
		const alreadyStaged = items.some(item => item.kind === 'selection' && item.path === model.uri.fsPath && item.startLine === startLine && item.endLine === endLine);
		if (!alreadyStaged) {
			items.push({ kind: 'selection', path: model.uri.fsPath, startLine, endLine, text: model.getValueInRange(selected) });
		}
	}

	const workingSet = editorWorkingSet(editorService, modelService, 'tabs');
	const isFile = (uri: URI) => uri.scheme === Schemas.file;
	return {
		items,
		editor: {
			activeFile: workingSet.activeFile && isFile(workingSet.activeFile) ? workingSet.activeFile.fsPath : undefined,
			openFiles: workingSet.openFiles.filter(isFile).map(uri => uri.fsPath),
		},
		isHidden: path => ignore.isIgnored(URI.file(path)),
	};
}
