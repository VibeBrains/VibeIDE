/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isAbsolute } from '../../../../base/common/path.js';
import { isLinux } from '../../../../base/common/platform.js';
import { extUri, extUriIgnorePathCase, isEqualOrParent, joinPath, normalizePath } from '../../../../base/common/resources.js';

/** A workspace root as the agent's path resolution sees it. */
export interface AgentPathRoot {
	readonly uri: URI;
	readonly name: string;
}

/**
 * Путь, названный агентом, → URI, который будут и проверять, и трогать.
 *
 * WHY this exists as a separate pure step: the workspace boundary used to be checked on the path
 * AS WRITTEN. `URI.file` and `URI.parse` keep `..` segments, and both the text comparison and the
 * workspace folder lookup (`findSubstr` over path segments) treat `..` as an ordinary name — so
 * `/proj/../../Users/x/.ssh/id_rsa` was «inside /proj» while naming a file outside it. Found by the
 * VibeIDEA session on 2026-09-11 and confirmed here by executing the built modules: the boundary
 * answered `/proj` for that path.
 *
 * The rule the fix rests on: `.` and `..` are resolved FIRST, and the resolved URI is what every
 * check sees AND what the tool acts on. A check and an action that name the same file differently
 * are two different files as far as safety is concerned.
 *
 * This is the lexical half only. A symlink inside the workspace that leads outside is invisible to
 * any lexical rule — that is resolved against the real filesystem at execution time, not here.
 */
export function resolveAgentPath(raw: string, roots: readonly AgentPathRoot[]): URI {
	let uri: URI;
	if (raw.includes('://')) {
		try {
			uri = URI.parse(raw);
		} catch (e) {
			throw new Error(`Invalid URI format: ${raw}. Error: ${e}`);
		}
	} else if (!isAbsolute(raw)) {
		// Relative to the first workspace root, as before; without a workspace it stays a bare path.
		uri = roots.length > 0 ? joinPath(roots[0].uri, raw) : URI.file(raw);
	} else {
		uri = URI.file(raw);
		// Models often write a project-relative path with a leading slash — `/carepilot-api/src` for
		// `<root>/src`. Re-rooting it is kept from the original heuristic, but «is this already inside
		// a root» is now decided on the RESOLVED path at a folder boundary, not by a text prefix.
		if (raw.startsWith('/')) {
			const lexical = normalizePath(uri);
			for (const root of roots) {
				if (isEqualOrParent(lexical, root.uri)) {
					break;
				}
				const name = root.name || root.uri.path.split('/').pop() || '';
				if (name && (raw === `/${name}` || raw.startsWith(`/${name}/`))) {
					uri = joinPath(root.uri, raw.slice(name.length + 1).replace(/^\//, ''));
					break;
				}
			}
		}
	}
	return normalizePath(uri);
}

/**
 * Deny rules compare paths ignoring case wherever the filesystem does.
 *
 * On APFS and NTFS `Secrets/` and `secrets/` are one folder, so a deny rule written one way must
 * catch the other — a case-sensitive check let `/proj/Raw/x.md` into a source folder declared as
 * `raw`. Linux keeps them apart. Allow rules never fold case: a mismatch there can only refuse.
 */
export const DENY_RULES_IGNORE_CASE = !isLinux;

/**
 * `uri` relative to `root`, or undefined when it is not under it — a sibling that merely shares a
 * prefix (`/ws-evil` next to `/ws`) is not. Unlike `relativePath` from resources this honours
 * `ignoreCase` for `file:` URIs too: that one defers to `path.relative`, which compares
 * case-sensitively on macOS whatever the flag says.
 */
export function pathUnder(root: URI, uri: URI, ignoreCase: boolean): string | undefined {
	if (!(ignoreCase ? extUriIgnorePathCase : extUri).isEqualOrParent(uri, root)) {
		return undefined;
	}
	return uri.path.slice(root.path.replace(/\/+$/, '').length).replace(/^\/+/, '');
}
