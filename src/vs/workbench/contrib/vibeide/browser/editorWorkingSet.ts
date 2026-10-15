/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { IModelService } from '../../../../editor/common/services/model.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';

/** The files the person is working with at the moment: the one in focus and the ones open next to it */
export interface IEditorWorkingSet {
	readonly activeFile: string | undefined;
	readonly openFiles: string[];
}

/**
 * The editor's working set, one reading for everything that tells an agent what is open
 * - `tabs`: every open tab of every group, visible or not
 * - `liveEditors`: only the files shown in an editor right now, which is what the cloud models' per-turn context uses
 */
export function editorWorkingSet(editorService: IEditorService, modelService: IModelService, source: 'tabs' | 'liveEditors'): IEditorWorkingSet {
	return {
		activeFile: editorService.activeEditor?.resource?.fsPath,
		openFiles: source === 'tabs'
			? editorService.editors.map(editor => editor.resource?.fsPath || '').filter(Boolean)
			: modelService.getModels().filter(model => model.isAttachedToEditor()).map(model => model.uri.fsPath),
	};
}
