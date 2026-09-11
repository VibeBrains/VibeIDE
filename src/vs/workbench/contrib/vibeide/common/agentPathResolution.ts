/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { isAbsolute } from '../../../../base/common/path.js';
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
 * Deny rules compare paths ignoring case — on every OS.
 *
 * On APFS and NTFS `Secrets/` and `secrets/` are one folder, so a deny rule written one way must
 * catch the other; a case-sensitive check once let `/proj/Raw/x.md` into a source folder declared as
 * `raw`. Folding only where the filesystem folds was tried first and dropped: case-insensitive
 * volumes exist on Linux too (WSL's `/mnt/c` is NTFS), the OS says nothing about the volume a path
 * lives on, and folding everywhere can only err towards refusing. VibeIDEA reads the shared rule files
 * the same way. Allow rules never fold case.
 */
export const DENY_RULES_IGNORE_CASE = true;

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

/**
 * A path as the project's rules see it.
 *
 * Rules are written against the project, like `.gitignore`: `src/**` means «src inside this project».
 * Matched against the full path it also meant every folder called `src` ABOVE the root — a project
 * checked out under `~/src/` got an allow list that allowed everything. So a file inside a workspace
 * root carries its path from that root, and one outside every root carries only its absolute path.
 */
export interface RuleSubject {
	/** Absolute path, forward slashes. */
	readonly absolute: string;
	/** Path from the workspace root the file lies under, forward slashes; absent outside every root. */
	readonly relative?: string;
}

/**
 * The rule subject of a path as callers have it: absolute, or already written against the project
 * (a project command's `cwd`). The containing root is found ignoring case — a deny must not miss a
 * file because the caller spelled the root differently — and the tail keeps its own case for the
 * exact allow rules.
 */
export function ruleSubjectOf(filePath: string, roots: readonly URI[]): RuleSubject {
	const uri = isAbsolute(filePath) ? URI.file(filePath) : roots.length > 0 ? joinPath(roots[0], filePath) : undefined;
	if (!uri) {
		const slashed = filePath.replace(/\\/g, '/');
		return { absolute: slashed, relative: slashed.replace(/^(?:\.?\/)+/, '') };
	}
	const absolute = uri.fsPath.replace(/\\/g, '/');
	for (const root of roots) {
		const relative = pathUnder(root, uri, DENY_RULES_IGNORE_CASE);
		if (relative !== undefined) {
			return { absolute, relative };
		}
	}
	return { absolute };
}

/** A bare string is matched as given — the frame the older callers and the tests use. */
export function asRuleSubject(target: string | RuleSubject): RuleSubject {
	if (typeof target !== 'string') {
		return target;
	}
	const slashed = target.replace(/\\/g, '/');
	return { absolute: slashed, relative: slashed };
}

/**
 * Whether a rule pattern names this subject; `test` matches one path string against the pattern.
 *
 * - A pattern without a leading `/` is matched against the path inside the project, never against
 *   folders above the root. For a file outside every root a DENY still looks at the absolute path (a
 *   secret is a secret wherever it lies); an ALLOW does not (a project's rule cannot grant a place
 *   outside the project — that takes a full path).
 * - A leading `/` anchors the pattern at the project root, as in `.gitignore`, or names a full path
 *   on disk. Both readings are tried: `/dist` meets `dist/` at the root, `/Users/me/p/**` the full path.
 * - A drive-letter or UNC pattern is a place on disk and meets the absolute path only.
 */
export function ruleMatches(subject: RuleSubject, pattern: string, kind: 'deny' | 'allow', test: (path: string) => boolean): boolean {
	const slashed = pattern.replace(/\\/g, '/');
	if (/^[A-Za-z]:\//.test(slashed) || slashed.startsWith('//')) {
		return test(subject.absolute);
	}
	if (slashed.startsWith('/')) {
		return (subject.relative !== undefined && test('/' + subject.relative)) || test(subject.absolute);
	}
	if (subject.relative !== undefined) {
		return test(subject.relative);
	}
	return kind === 'deny' && test(subject.absolute);
}
