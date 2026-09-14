/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';
import { basename, dirname, isEqual, joinPath } from '../../../../base/common/resources.js';
import { pathUnder } from './agentPathResolution.js';

/** What the physical resolution needs from a filesystem — injected, so the logic is testable. */
export interface PhysicalPathProbe {
	exists(uri: URI): Promise<boolean>;
	/**
	 * The path with every symlink resolved, for a path that EXISTS. `undefined` means the filesystem
	 * cannot resolve links at all; a thrown error means it tried and failed on this entry.
	 */
	realpath(uri: URI): Promise<URI | undefined>;
}

export type PhysicalPath =
	/** Where the path lands on disk. */
	| { readonly kind: 'resolved'; readonly uri: URI }
	/** The filesystem has no notion of links — only the lexical answer exists, as before. */
	| { readonly kind: 'unsupported' }
	/**
	 * An entry exists but cannot be resolved: a dangling symlink, or no permission to follow it.
	 * A write through it would land somewhere nobody checked.
	 */
	| { readonly kind: 'unresolvable'; readonly at: URI };

/** Enough to climb from any real path to its root; a longer climb means a loop, not a path. */
const MAX_DEPTH = 4096;

/**
 * Где путь окажется на диске на самом деле.
 *
 * The lexical step (`resolveAgentPath`) resolves `.` and `..` but cannot see a symlink: a link
 * inside the workspace that leads outside is «inside» for every rule that reads the path as text.
 *
 * A path that does not exist yet — the file a write is about to create — has no realpath of its
 * own, so the deepest EXISTING ancestor is resolved and the not-yet-existing tail is appended to it.
 *
 * An existing entry that refuses to resolve is reported, not skipped. That is the dangling symlink:
 * `exists()` answers yes for it, `realpath` fails, and a write through it creates the file on the
 * far side of the link. Treating the failure as «nothing to resolve» would wave exactly that through.
 */
export async function resolvePhysicalPath(uri: URI, probe: PhysicalPathProbe): Promise<PhysicalPath> {
	const tail: string[] = [];
	let current = uri;
	for (let depth = 0; depth < MAX_DEPTH; depth++) {
		if (await probe.exists(current)) {
			let real: URI | undefined;
			try {
				real = await probe.realpath(current);
			} catch {
				return { kind: 'unresolvable', at: current };
			}
			if (!real) {
				return { kind: 'unsupported' };
			}
			return { kind: 'resolved', uri: tail.length > 0 ? joinPath(real, ...[...tail].reverse()) : real };
		}
		const parent = dirname(current);
		if (isEqual(parent, current)) {
			// Climbed to the root without finding anything that exists — nothing to resolve against.
			return { kind: 'unsupported' };
		}
		tail.push(basename(current));
		current = parent;
	}
	return { kind: 'unresolvable', at: current };
}

/**
 * The entry a delete removes: the containing folder resolved, the name kept as is.
 *
 * Deleting a symlink removes the link, not what it points to, so resolving the link itself would
 * refuse to delete a link that sits inside the workspace. What must be inside is the folder the
 * entry lives in.
 */
export async function resolvePhysicalEntry(uri: URI, probe: PhysicalPathProbe): Promise<PhysicalPath> {
	const parent = await resolvePhysicalPath(dirname(uri), probe);
	return parent.kind === 'resolved' ? { kind: 'resolved', uri: joinPath(parent.uri, basename(uri)) } : parent;
}

/** A workspace root under both of its names. */
export interface PhysicalRoot {
	/** As the workspace knows it — the frame every rule and every setting was written in. */
	readonly seen: URI;
	/** Where it is on disk. Differs when the root itself is reached through a symlink. */
	readonly real: URI;
}

/**
 * Где лежит развёрнутый путь относительно корней проекта — и как его зовут в их системе имён.
 *
 * A resolved path is compared with resolved roots, never with the roots as the workspace names
 * them: on the owner's machine `~/Projects` is itself a link to another volume, and a resolved file
 * compared with an unresolved root is outside every time — every write in the project refused.
 *
 * `seen` spells the file against the root as the workspace knows it, because that is the frame the
 * user's rules are written in (source folders, allow lists, `.vibe/ignore`). Of several matching
 * roots the deepest wins: with a nested root, the inner folder is the one that describes the file.
 * Case is compared exactly — «inside» is an allow, and an allow that errs may only refuse.
 */
export function placePhysicalPath(physical: URI, roots: readonly PhysicalRoot[]): { readonly inside: boolean; readonly seen: URI } {
	let home: { readonly root: PhysicalRoot; readonly rel: string } | undefined;
	for (const root of roots) {
		const rel = pathUnder(root.real, physical, false);
		if (rel !== undefined && (!home || root.real.path.length > home.root.real.path.length)) {
			home = { root, rel };
		}
	}
	if (!home) {
		return { inside: false, seen: physical };
	}
	return { inside: true, seen: home.rel ? joinPath(home.root.seen, home.rel) : home.root.seen };
}
