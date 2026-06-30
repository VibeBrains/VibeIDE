/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VIBE_DEFAULTS_MANIFEST } from './vibeDefaultsManifest.generated.js';

export interface ApplyVibeDefaultsResult {
	readonly created: number;
	readonly skipped: number;
}

/**
 * Seeds the workspace `.vibe/` folder with the default agent scaffolding embedded from
 * `.vibe-defaults/` (see vibeDefaultsManifest.generated.ts — regenerated from disk on every build,
 * so the set is never hard-coded). Used both on first workspace open (VibeConfigInitContribution)
 * and by the «Установить дефолтную обвязку для агентов» command.
 *
 * Default behaviour is create-if-missing: existing files are left untouched so user edits survive.
 * `overwrite: true` force-rewrites every default file (reset to factory). `IFileService.writeFile`
 * creates intermediate directories, so nested paths (skills/<id>/SKILL.md, .../scripts/*.py) just work.
 */
export async function applyVibeDefaults(
	fileService: IFileService,
	vibeDir: URI,
	options?: { readonly overwrite?: boolean },
): Promise<ApplyVibeDefaultsResult> {
	const overwrite = options?.overwrite === true;
	let created = 0;
	let skipped = 0;

	for (const file of VIBE_DEFAULTS_MANIFEST) {
		const target = joinPath(vibeDir, ...file.path.split('/'));
		if (!overwrite) {
			let exists = false;
			try {
				await fileService.stat(target);
				exists = true;
			} catch {
				exists = false;
			}
			if (exists) { skipped++; continue; }
		}
		await fileService.writeFile(target, VSBuffer.fromString(file.contents));
		created++;
	}

	return { created, skipped };
}
