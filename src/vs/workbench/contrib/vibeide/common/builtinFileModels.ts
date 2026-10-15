/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { VibeideStatefulModelInfo } from './vibeideSettingsTypes.js';

/** A `models.static` entry of a provider file, as far as the model list needs it */
export type FileStaticModel = { readonly id: string; readonly name?: string };

/**
 * The model list of a BUILT-IN provider as Settings and the chat picker both see it
 * The catalogue models stay as they are; the file's `static` models the catalogue lacks are appended, marked `fileNote`
 * A file model is derived on every apply, never stored: it is removed from the file, it is gone from the list
 * Whether it is shown is the user's toggle (`hiddenById`), and a model the file declares is shown until the user hides it
 * Returns the very same array when nothing changes, so callers can skip a state rebuild
 */
export function withBuiltinFileModels(
	models: readonly VibeideStatefulModelInfo[],
	fileStatic: readonly FileStaticModel[] | undefined,
	hiddenById: Readonly<Record<string, boolean>> | undefined,
): VibeideStatefulModelInfo[] {
	const own = models.filter(m => m.fileNote === undefined);
	const listed = new Set(own.map(m => m.modelName));
	const derived: VibeideStatefulModelInfo[] = [];
	for (const { id } of fileStatic ?? []) {
		if (listed.has(id)) { continue; }
		listed.add(id);
		derived.push({ modelName: id, type: 'autodetected', isHidden: hiddenById?.[id] ?? false, fileNote: 'manual' });
	}
	const next = [...own, ...derived];
	const same = next.length === models.length && next.every((m, i) => {
		const old = models[i];
		return old.modelName === m.modelName && old.type === m.type && old.isHidden === m.isHidden && old.fileNote === m.fileNote;
	});
	return same ? models as VibeideStatefulModelInfo[] : next;
}

/** The models worth writing to the settings blob: the file-derived ones are rebuilt from the file on load */
export function withoutFileModels(models: readonly VibeideStatefulModelInfo[]): VibeideStatefulModelInfo[] {
	return models.some(m => m.fileNote !== undefined) ? models.filter(m => m.fileNote === undefined) : models as VibeideStatefulModelInfo[];
}
