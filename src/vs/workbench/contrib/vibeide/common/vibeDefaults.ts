/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VIBE_DEFAULTS_MANIFEST, VIBE_DEPRECATED_MANIFEST, VibeDeprecatedSeed } from './vibeDefaultsManifest.generated.js';

export interface ApplyVibeDefaultsResult {
	readonly created: number;
	readonly skipped: number;
}

/** URI scheme serving the release's version of a default file, read-only (for diffing against `.vibe/`). */
export const VIBE_DEFAULT_SCHEME = 'vibe-default';

/**
 * Reconciliation record: `.vibe/.defaults.lock.json`. Deliberately NOT in `.vibe/.gitignore` — unlike
 * the runtime artifacts listed there this is a project decision («we keep our own rules.md against
 * release X»), so it should travel with the repo. Were it machine-local, every teammate would be
 * nagged separately about the same shared customization.
 */
export const VIBE_DEFAULTS_LOCK_FILE = '.defaults.lock.json';

/**
 * One reconciliation point: at the moment this was written, the release shipped `release` and the
 * user's file ended up as `local`. Both hashes are needed — knowing only what we seeded cannot tell
 * «the release moved» from «the user edited», and those need opposite handling.
 */
interface VibeDefaultsLockEntry {
	readonly release: string;
	readonly local: string;
}

interface VibeDefaultsLock {
	readonly version: 1;
	readonly files: { readonly [path: string]: VibeDefaultsLockEntry };
}

/**
 * Per-file state, derived from three inputs: the release's content, the file on disk, and the last
 * reconciliation point. The whole reason the lock exists is the difference between `outdated` and
 * `customized` — without it both look like «differs» and we would nag the user about their own text.
 *
 * `missing`    — release has it, workspace does not. Safe to add.
 * `outdated`   — the release moved, the user did not touch the file since. Safe to update: nothing to lose.
 * `customized` — the user's file, and the release has not moved since they settled on it. **Quiet**:
 *                a customized file differs from the release forever, which is not news.
 * `conflict`   — both moved since the last reconciliation. Needs a human (diff).
 * `unknown`    — differs, but never reconciled (no lock entry — a `.vibe` predating the lock file).
 *                Cannot be classified; surfaced once so the user can resolve it.
 * `same`       — identical to the release.
 */
export type VibeDefaultStatus = 'missing' | 'same' | 'outdated' | 'customized' | 'conflict' | 'unknown';

export interface VibeDefaultsDiffEntry {
	/** POSIX path relative to the workspace `.vibe/` folder. */
	readonly path: string;
	readonly status: VibeDefaultStatus;
}

export interface VibeDefaultsDiff {
	readonly entries: readonly VibeDefaultsDiffEntry[];
	readonly missing: readonly VibeDefaultsDiffEntry[];
	readonly outdated: readonly VibeDefaultsDiffEntry[];
	readonly customized: readonly VibeDefaultsDiffEntry[];
	readonly conflict: readonly VibeDefaultsDiffEntry[];
	readonly unknown: readonly VibeDefaultsDiffEntry[];
	readonly same: readonly VibeDefaultsDiffEntry[];
	/** True when something changed on the RELEASE side — the only honest reason to interrupt the user. */
	readonly needsAttention: boolean;
}

/**
 * Manifest contents are LF-normalized by the generator, while a file on disk may hold CRLF (Windows
 * checkout or an editor that saved it that way). Hash on LF, otherwise every seeded file on Windows
 * would look modified purely on line endings.
 */
function normalizeEol(text: string): string {
	return text.replace(/\r\n/g, '\n');
}

function sha(text: string): string {
	const h = new StringSHA1();
	h.update(normalizeEol(text));
	return h.digest();
}

/** The release's content for a default file, or `undefined` if the manifest has no such path. */
export function vibeDefaultContent(path: string): string | undefined {
	return VIBE_DEFAULTS_MANIFEST.find(f => f.path === path)?.contents;
}

async function readLock(fileService: IFileService, vibeDir: URI): Promise<VibeDefaultsLock['files']> {
	try {
		const raw = await fileService.readFile(joinPath(vibeDir, VIBE_DEFAULTS_LOCK_FILE));
		const parsed = JSON.parse(raw.value.toString()) as VibeDefaultsLock;
		return parsed?.version === 1 && parsed.files ? parsed.files : {};
	} catch {
		return {}; // absent or corrupt — every file is simply «never reconciled»
	}
}

/**
 * Records reconciliation points for `paths` at their CURRENT state: whatever the file looks like now
 * is what the user meant it to look like, against the release they have now. This is what stops a
 * customized file from nagging forever — and why it is called after every resolution path, including
 * «оставить своё».
 */
export async function recordVibeDefaultsReconciled(
	fileService: IFileService,
	vibeDir: URI,
	paths: readonly string[],
): Promise<void> {
	const files: { [path: string]: VibeDefaultsLockEntry } = { ...await readLock(fileService, vibeDir) };

	for (const path of paths) {
		const release = vibeDefaultContent(path);
		if (release === undefined) {
			continue;
		}
		let local: string;
		try {
			local = sha((await fileService.readFile(joinPath(vibeDir, ...path.split('/')))).value.toString());
		} catch {
			continue; // nothing on disk to reconcile with
		}
		files[path] = { release: sha(release), local };
	}

	// Sorted keys → the file is diff-stable across runs and machines (it may well be committed).
	const sorted: { [path: string]: VibeDefaultsLockEntry } = {};
	for (const path of Object.keys(files).sort()) {
		sorted[path] = files[path];
	}
	const lock: VibeDefaultsLock = { version: 1, files: sorted };
	await fileService.writeFile(
		joinPath(vibeDir, VIBE_DEFAULTS_LOCK_FILE),
		VSBuffer.fromString(JSON.stringify(lock, null, '\t') + '\n'),
	);
}

/**
 * Compares the workspace `.vibe/` against the defaults embedded in this release, using the lock to
 * tell «the release moved» from «the user edited».
 *
 * Read-only. Files present in `.vibe/` but absent from the manifest (the user's own) are ignored:
 * this reports on what the release ships and never proposes deleting anything.
 */
export async function diffVibeDefaults(
	fileService: IFileService,
	vibeDir: URI,
): Promise<VibeDefaultsDiff> {
	const locks = await readLock(fileService, vibeDir);
	const entries: VibeDefaultsDiffEntry[] = [];

	for (const file of VIBE_DEFAULTS_MANIFEST) {
		if (file.path === VIBE_DEFAULTS_LOCK_FILE) {
			continue; // never compare the bookkeeping against itself
		}
		const target = joinPath(vibeDir, ...file.path.split('/'));

		let localText: string;
		try {
			localText = (await fileService.readFile(target)).value.toString();
		} catch {
			entries.push({ path: file.path, status: 'missing' }); // absent, unreadable or a directory
			continue;
		}

		const localSha = sha(localText);
		const releaseSha = sha(file.contents);
		if (localSha === releaseSha) {
			entries.push({ path: file.path, status: 'same' });
			continue;
		}

		const lock = locks[file.path];
		if (!lock) {
			entries.push({ path: file.path, status: 'unknown' });
			continue;
		}

		const userMoved = localSha !== lock.local;
		const releaseMoved = releaseSha !== lock.release;
		const status: VibeDefaultStatus = releaseMoved
			? (userMoved ? 'conflict' : 'outdated')
			: 'customized'; // release stood still → the difference is the user's own, settled choice
		entries.push({ path: file.path, status });
	}

	const of = (s: VibeDefaultStatus) => entries.filter(e => e.status === s);
	const missing = of('missing');
	const outdated = of('outdated');
	const conflict = of('conflict');
	const unknown = of('unknown');

	return {
		entries,
		missing,
		outdated,
		customized: of('customized'),
		conflict,
		unknown,
		same: of('same'),
		// `customized` is deliberately excluded: it differs from the release by the user's own
		// decision and would otherwise nag on every single open.
		needsAttention: missing.length + outdated.length + conflict.length + unknown.length > 0,
	};
}

/**
 * Seeds the workspace `.vibe/` environment with the defaults embedded from `.vibe-defaults/` (see
 * vibeDefaultsManifest.generated.ts — regenerated from disk on every build, so the set is never
 * hard-coded). Runs on every workspace open (VibeConfigInitContribution) and from «Обновить
 * окружение из релиза».
 *
 * Default behaviour is create-if-missing: existing files are left untouched so user edits survive —
 * which also means a file the release has since changed keeps its old content until `overwrite`
 * rewrites it. `only` restricts the write to specific manifest paths, which is how «обновить
 * незатронутые» updates exactly the files the user never touched and nothing else.
 *
 * `IFileService.writeFile` creates intermediate directories, so nested paths just work.
 */
export async function applyVibeDefaults(
	fileService: IFileService,
	vibeDir: URI,
	options?: { readonly overwrite?: boolean; readonly only?: readonly string[] },
): Promise<ApplyVibeDefaultsResult> {
	const overwrite = options?.overwrite === true;
	const only = options?.only ? new Set(options.only) : undefined;
	let created = 0;
	let skipped = 0;

	const written: string[] = [];
	for (const file of VIBE_DEFAULTS_MANIFEST) {
		if (only && !only.has(file.path)) {
			continue;
		}
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
		written.push(file.path);
		created++;
	}

	// A file we just wrote is by definition reconciled — otherwise the next open would report the
	// freshly seeded file as `unknown` and ask the user about a decision they never made.
	if (written.length > 0) {
		await recordVibeDefaultsReconciled(fileService, vibeDir, written);
	}

	return { created, skipped };
}

/**
 * SHA-256 hex over LF-normalized UTF-8 — the digest convention of `deprecated.json` in the shared
 * VibeBrains set (hashes there were taken from LF files; normalizing here keeps Windows checkouts
 * with CRLF from looking «edited» purely on line endings). SHA-1 above serves the lock; deprecated
 * hashes are produced outside this codebase, so the algorithm is part of the set's contract.
 */
async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalizeEol(text)));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

export interface CleanupDeprecatedResult {
	/** Stale seeds deleted: byte-matched a known historical version, so nothing of the user's was lost. */
	readonly removed: readonly string[];
	/** Stale seeds LEFT in place: the copy differs from every known version — it is the user's work. */
	readonly keptModified: readonly string[];
}

/**
 * Deletes stale seeds — files the shared set has dropped or renamed (`deprecated.json` in
 * VibeBrains) — but ONLY when the workspace copy matches a known historical version. Runs after
 * seeding on workspace open; an edited copy is reported, never touched. Removed paths also leave
 * the reconciliation lock, otherwise the next diff would resurrect them as `unknown`.
 */
export async function cleanupDeprecatedVibeDefaults(
	fileService: IFileService,
	vibeDir: URI,
	entries: ReadonlyArray<VibeDeprecatedSeed> = VIBE_DEPRECATED_MANIFEST,
): Promise<CleanupDeprecatedResult> {
	const removed: string[] = [];
	const keptModified: string[] = [];
	for (const entry of entries) {
		const target = joinPath(vibeDir, ...entry.path.split('/'));
		let raw: string;
		try {
			raw = (await fileService.readFile(target)).value.toString();
		} catch {
			continue; // already gone — nothing to clean
		}
		if (entry.sha256.includes(await sha256Hex(raw))) {
			try {
				await fileService.del(target);
				removed.push(entry.path);
			} catch {
				// Deletion is best-effort: a locked file stays until the next open.
			}
		} else {
			keptModified.push(entry.path);
		}
	}
	if (removed.length > 0) {
		await removeFromVibeDefaultsLock(fileService, vibeDir, removed);
	}
	return { removed, keptModified };
}

/** Drops [paths] from the lock so a deleted stale seed does not linger as a phantom entry. */
async function removeFromVibeDefaultsLock(
	fileService: IFileService,
	vibeDir: URI,
	paths: readonly string[],
): Promise<void> {
	const files = { ...await readLock(fileService, vibeDir) };
	let changed = false;
	for (const path of paths) {
		if (path in files) {
			delete files[path];
			changed = true;
		}
	}
	if (!changed) {
		return;
	}
	const lock: VibeDefaultsLock = { version: 1, files };
	await fileService.writeFile(
		joinPath(vibeDir, VIBE_DEFAULTS_LOCK_FILE),
		VSBuffer.fromString(JSON.stringify(lock, null, '\t') + '\n'),
	);
}
