/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { vibeLog } from './vibeLog.js';

/**
 * Рантайм-состояние переехало в `.vibe/local/`.
 *
 * WHY a folder rather than more lines in `.gitignore`: everything the IDE writes about itself —
 * what ran, what was planned — is derived, machine-local and uninteresting to a repository. One
 * ignored folder says that once; a list of file names has to be extended every time something new
 * is written, and the one that gets forgotten is the one that leaks into a commit.
 *
 * WHAT DOES NOT MOVE HERE, on purpose:
 *  • `.vibe/.env` — machine-local but written by a HUMAN. It is configuration, not a derivative,
 *    and moving it would silently lose the keys of everyone who already has one.
 *  • the audit log — it left `.vibe` entirely for `workspaceStorageHome`, because a journal inside
 *    the working folder sits within reach of the agent's own file tools. `local/` would put it
 *    back in that reach; this module must not be used to undo that.
 */
export const VIBE_LOCAL_DIR = 'local';

/**
 * Path in the new location, carrying the old file across on first use.
 *
 * The move is best-effort and fail-open: if the destination already holds something we leave it
 * alone, and if the copy fails for any reason — file busy, no permission — the OLD path is
 * returned and work continues there. Losing a run ledger to a tidying step nobody asked for would
 * be a worse outcome than a file left in the old place.
 *
 * Returns `undefined` only when there is no workspace folder to anchor to.
 */
export async function resolveRuntimeStatePath(
	fileService: IFileService,
	workspaceFolder: URI | undefined,
	fileName: string,
): Promise<URI | undefined> {
	if (!workspaceFolder) {
		return undefined;
	}
	const vibeDir = joinPath(workspaceFolder, '.vibe');
	const target = joinPath(vibeDir, VIBE_LOCAL_DIR, fileName);
	const legacy = joinPath(vibeDir, fileName);

	try {
		if (await fileService.exists(target)) {
			return target;
		}
		if (await fileService.exists(legacy)) {
			// Copy-then-delete rather than move: if the delete fails we are left with two copies,
			// which is recoverable. A failed move can leave neither.
			await fileService.copy(legacy, target, /*overwrite*/ false);
			try {
				await fileService.del(legacy);
			} catch (err) {
				vibeLog.debug('runtimeState', `${fileName}: перенесён, но старый файл не удалён — ${err}`);
			}
			return target;
		}
		return target;
	} catch (err) {
		vibeLog.debug('runtimeState', `${fileName}: перенос не удался, работаем по старому пути — ${err}`);
		return legacy;
	}
}
