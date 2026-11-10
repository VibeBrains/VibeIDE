/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { StringSHA1 } from '../../../../base/common/hash.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { VIBE_DEFAULTS_MANIFEST, VIBE_DEPRECATED_MANIFEST, VIBE_VERSIONS_MANIFEST, VibeDeprecatedSeed, VibeSeedRevision } from './vibeDefaultsManifest.generated.js';
import { recordSeedBases, SeedBaseRecord } from './vibeSeedBase.js';

export interface ApplyVibeDefaultsResult {
	readonly created: number;
	readonly skipped: number;
}

/** URI scheme serving the release's version of a default file, read-only (for diffing against `.vibe/`). */
export const VIBE_DEFAULT_SCHEME = 'vibe-default';

/** URI-схема «вашего файла» на момент слияния: у редактора слияния сторона и результат не могут быть одним ресурсом. */
export const VIBE_SEED_YOURS_SCHEME = 'vibe-seed-yours';

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
 * `outdated`   — the release moved, and the file is still an untouched copy of an older release (on the last
 *                reconciliation it equalled the release). Safe to update: nothing to lose.
 * `customized` — the user's file, and the release has not moved since they settled on it. **Quiet**:
 *                a customized file differs from the release forever, which is not news.
 * `conflict`   — both moved since the last reconciliation, or the release moved on past a copy the user had
 *                settled as their own. Needs a human (merge).
 * `unknown`    — differs, but never reconciled (no lock entry — a `.vibe` predating the lock file).
 *                Cannot be classified; surfaced once so the user can resolve it.
 * `same`       — identical to the release.
 */
export type VibeDefaultStatus = 'missing' | 'same' | 'outdated' | 'customized' | 'conflict' | 'unknown';

export interface VibeDefaultsDiffEntry {
	/** POSIX path relative to the workspace `.vibe/` folder. */
	readonly path: string;
	readonly status: VibeDefaultStatus;
	/** Версия из шапки копии пользователя; нет версии — `undefined` (в отчёте «—»). */
	readonly localVersion?: string;
	/** Версия из реестра набора; у файлов без поля в реестре — `undefined`. */
	readonly releaseVersion?: string;
}

/**
 * Версия файла набора из его шапки. Контракт набора различает два места: у навыка
 * (`SKILL.md`) версия лежит вложенно в `metadata`, у правила (`.mdc`) — ключом верхнего
 * уровня. Читается только шапка: одноимённое поле в JSON-файлах продукта — версия формата,
 * а не ревизия набора.
 */
export function vibeSeedFileVersion(path: string, text: string): string | undefined {
	const block = frontmatterBlock(text);
	if (!block) {
		return undefined;
	}
	const isSkill = path === 'SKILL.md' || path.endsWith('/SKILL.md');
	if (isSkill) {
		return nestedMetadataValue(block, 'vibeVersion') ?? topLevelScalar(block, 'vibeVersion');
	}
	if (path.endsWith('.mdc')) {
		return topLevelScalar(block, 'vibeVersion') ?? nestedMetadataValue(block, 'vibeVersion');
	}
	return undefined;
}

/** «Было → стало» без догадок: отсутствующая сторона честно показывается прочерком. */
export function formatVibeVersionChange(from: string | undefined, to: string | undefined): string {
	return `${from ?? '—'} → ${to ?? '—'}`;
}

function frontmatterBlock(text: string): string | undefined {
	// BOM снимается по коду, а не литералом в регулярке: невидимый символ в исходнике не переживёт правку
	const withoutBom = text.charCodeAt(0) === 0xFEFF ? text.slice(1) : text;
	const match = withoutBom.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
	return match?.[1];
}

/** Значение ключа верхнего уровня шапки: строка сразу после `---`, без отступа. */
function topLevelScalar(block: string, key: string): string | undefined {
	const match = new RegExp(`^${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'im').exec(block);
	return match?.[1]?.trim() || undefined;
}

/** Значение внутри блока `metadata:` — вложенность задаётся отступом, а не именем файла. */
function nestedMetadataValue(block: string, key: string): string | undefined {
	const lines = block.split(/\r?\n/);
	const start = lines.findIndex(line => /^metadata:\s*$/.test(line));
	if (start < 0) {
		return undefined;
	}
	const value = new RegExp(`^\\s+${key}:\\s*["']?([^"'\\n]+?)["']?\\s*$`, 'i');
	for (let i = start + 1; i < lines.length; i++) {
		const line = lines[i];
		if (!line.trim()) {
			continue;
		}
		if (!/^\s/.test(line)) {
			break; // верхний уровень — блок `metadata` закончился
		}
		const match = value.exec(line);
		if (match) {
			return match[1].trim() || undefined;
		}
	}
	return undefined;
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
 *
 * Вместе с точкой сверки сохраняется текст ревизии набора, которую человек этим решением увидел: он станет
 * основой следующего слияния, когда набор уйдёт дальше. Журнал хранит только хеши, по ним текст не восстановить.
 */
export async function recordVibeDefaultsReconciled(
	fileService: IFileService,
	vibeDir: URI,
	paths: readonly string[],
): Promise<void> {
	const files: { [path: string]: VibeDefaultsLockEntry } = { ...await readLock(fileService, vibeDir) };
	const bases: SeedBaseRecord[] = [];

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
		bases.push({ path, contents: release });
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
	await recordSeedBases(fileService, vibeDir, bases);
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
	revisions: ReadonlyArray<VibeSeedRevision> = VIBE_VERSIONS_MANIFEST,
): Promise<VibeDefaultsDiff> {
	const locks = await readLock(fileService, vibeDir);
	const entries: VibeDefaultsDiffEntry[] = [];

	for (const file of VIBE_DEFAULTS_MANIFEST) {
		if (file.path === VIBE_DEFAULTS_LOCK_FILE) {
			continue; // never compare the bookkeeping against itself
		}
		const target = joinPath(vibeDir, ...file.path.split('/'));
		// «Стало» берётся из реестра, а не из шапки релиза: реестр — единственный источник,
		// который знает версию и для файлов, чью шапку человек уже переписал
		const releaseVersion = revisions.find(r => r.path === file.path)?.vibeVersion;
		const push = (status: VibeDefaultStatus, localText?: string) => entries.push({
			path: file.path,
			status,
			localVersion: localText === undefined ? undefined : vibeSeedFileVersion(file.path, localText),
			releaseVersion,
		});

		let localText: string;
		try {
			localText = (await fileService.readFile(target)).value.toString();
		} catch {
			push('missing'); // absent, unreadable or a directory
			continue;
		}

		const localSha = sha(localText);
		const releaseSha = sha(file.contents);
		if (localSha === releaseSha) {
			push('same', localText);
			continue;
		}

		const lock = locks[file.path];
		if (!lock) {
			// Нет точки сверки — но реестр ревизий набора помнит sha256 всех прошлых версий файла.
			// Совпадение означает нетронутую копию старого релиза: обновлять её безопасно, и
			// спрашивать не о чем. Так классифицируются проекты, засеянные до появления lock —
			// иначе каждый их файл навсегда оставался бы «unknown» и никогда не обновлялся.
			const known = await isUntouchedPastRevision(file.path, localText, revisions);
			push(known ? 'outdated' : 'unknown', localText);
			continue;
		}

		const userMoved = localSha !== lock.local;
		const releaseMoved = releaseSha !== lock.release;
		// На точке сверки файл уже отличался от релиза: это решение человека («оставить своё», ручное слияние).
		// Когда набор уйдёт дальше, перезаписать такой файл — потерять его правки, поэтому нужен человек, а не «обновить безопасно»
		const settledOwn = lock.local !== lock.release;
		// The lock and the file can part ways — a merge, a branch that carries the file but not the lock, one file
		// checked out alone. A copy that is byte for byte an old release is untouched whatever the lock says:
		// Read as the user's own choice it would stay old for good
		if (userMoved && await isUntouchedPastRevision(file.path, localText, revisions)) {
			push('outdated', localText);
			continue;
		}
		const status: VibeDefaultStatus = releaseMoved
			? (userMoved || settledOwn ? 'conflict' : 'outdated')
			: 'customized'; // release stood still → the difference is the user's own, settled choice
		push(status, localText);
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
 * Досыпает базы слияния тем файлам, чей текст в точности равен ревизии набора, и ничего больше не трогает.
 *
 * `same` — копия равна нынешней ревизии, значит, база — текст набора.
 * `outdated` — копия не тронута с тех пор, как совпадала с прежней ревизией, значит, её текст и есть та ревизия.
 * Так проекты, засеянные до появления баз, получают их без участия человека, пока файл ещё не правлен.
 * Правленым файлам (`conflict`, `customized`, `unknown`) базу не придумать: их текст — уже не ревизия набора.
 *
 * Читает только файлы `outdated`; `diff` уже посчитан вызывающим, второй обход не нужен.
 */
export async function refreshSeedBases(
	fileService: IFileService,
	vibeDir: URI,
	diff: VibeDefaultsDiff,
): Promise<number> {
	const records: SeedBaseRecord[] = [];
	for (const entry of diff.same) {
		const release = vibeDefaultContent(entry.path);
		if (release !== undefined) {
			records.push({ path: entry.path, contents: release });
		}
	}
	for (const entry of diff.outdated) {
		try {
			const local = (await fileService.readFile(joinPath(vibeDir, ...entry.path.split('/')))).value.toString();
			records.push({ path: entry.path, contents: local });
		} catch {
			continue; // файл пропал между сверкой и чтением — базы не будет, это не ошибка
		}
	}
	return recordSeedBases(fileService, vibeDir, records);
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

/**
 * Знает ли набор эту копию как одну из своих ревизий (значит, её никто не правил).
 * [revisions] параметром — чтобы тесты гоняли обе ветки, не завися от текущего набора.
 */
export async function isUntouchedPastRevision(
	path: string,
	localText: string,
	revisions: ReadonlyArray<VibeSeedRevision> = VIBE_VERSIONS_MANIFEST,
): Promise<boolean> {
	const revision = revisions.find(r => r.path === path);
	if (!revision) {
		return false;
	}
	const digest = await sha256Hex(localText);
	return digest === revision.sha256 || revision.history.includes(digest);
}
