/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Working-tree snapshots for checkpoints.
 *
 * Checkpoints record file contents that passed through `editCodeService` — the agent's own edits.
 * Anything that changed the tree another way is invisible to them: a build script, `git checkout`,
 * a `sed` the agent ran in the terminal. Rolling back to such a checkpoint restores the files it
 * knows and silently leaves the rest, which is worse than not rolling back at all, because the
 * result looks like a clean restore.
 *
 * The snapshot is a git tree object written through a **temporary index**, so the user's real index
 * (staged changes) is never touched. `git stash create` was rejected: it does not capture untracked
 * files, and untracked output is precisely what terminal work produces.
 *
 * This module is pure — it builds argument vectors and decides what a restore would do. The process
 * spawning lives in the main-process service; the decisions live here so they are testable.
 */

/** Files git reports, split by how the restore must treat them. */
export interface SnapshotRestorePlan {
	/** Paths present in the snapshot: overwritten from it. */
	readonly restore: readonly string[];
	/** Paths absent from the snapshot but present now: deleted by the restore. */
	readonly delete: readonly string[];
}

/**
 * Refs live under a private namespace: `refs/vibe/...` never shows up in `git branch`, is not pushed
 * by default, and cannot collide with anything the user creates.
 */
export const SNAPSHOT_REF_PREFIX = 'refs/vibe/checkpoints';

export function snapshotRefName(id: string): string {
	return `${SNAPSHOT_REF_PREFIX}/${id}`;
}

/** Argv (without the leading `git`) for the commands a snapshot needs. */
export const SNAPSHOT_ARGV = {
	repoRoot: ['rev-parse', '--show-toplevel'],
	/** Stage everything — tracked, modified and untracked alike — into the temporary index. */
	stageAll: ['add', '-A'],
	writeTree: ['write-tree'],
	/**
	 * Wrap the tree in a parentless commit. Without this the snapshot is an unreachable object and
	 * `git gc` deletes it — verified: `git gc --prune=now` made a freshly written tree unreadable, so
	 * restoring an older checkpoint would have failed with nothing to point at.
	 */
	commitTree: (tree: string, message: string) => ['commit-tree', tree, '-m', message],
	/** Give the commit a ref so it stays reachable for good, out of the way of user branches. */
	updateRef: (id: string, commit: string) => [`update-ref`, snapshotRefName(id), commit],
	readTree: (tree: string) => ['read-tree', tree],
	/** Write the temporary index out over the working tree. */
	checkoutIndex: ['checkout-index', '-a', '-f'],
	listTree: (tree: string) => ['ls-tree', '-r', '--name-only', tree],
	/** Everything git currently considers part of the working set, ignored files excluded. */
	listWorking: ['ls-files', '--cached', '--others', '--exclude-standard'],
	/** Pinned snapshots with the age of each, so a young one can be spared. */
	listSnapshotRefs: ['for-each-ref', '--format=%(refname) %(committerdate:unix)', SNAPSHOT_REF_PREFIX],
	deleteRef: (id: string) => ['update-ref', '-d', snapshotRefName(id)],
	/** Tree behind an existing snapshot commit — the basis for skipping an unchanged turn. */
	treeOfCommit: (commit: string) => ['rev-parse', `${commit}^{tree}`],
} as const;

/** Что известно о ходе в момент снимка. Всё необязательно: снимок ценен и без подписи. */
export interface SnapshotCommitMeta {
	/** Порядковый номер хода в треде. */
	readonly turnIndex?: number;
	/** Инструмент, после которого сделан снимок, если снимок привязан к нему. */
	readonly toolName?: string;
	readonly threadId?: string;
}

/**
 * Сообщение коммита-снимка.
 *
 * Раньше это была одна и та же строка на все снимки, и `git log` по нашим ссылкам показывал
 * столбец одинаковых фраз — то есть не отвечал ни на один вопрос, ради которого в него смотрят.
 * Номер хода, инструмент и дерево делают снимок читаемым без нашего интерфейса: `git log
 * refs/vibe/checkpoints/*` становится историей работы агента, а не списком «snapshot».
 *
 * Первая строка короткая (её показывает `--oneline`), подробности — телом.
 */
export function snapshotCommitMessage(treeSha: string, meta: SnapshotCommitMeta = {}): string {
	const head = meta.turnIndex !== undefined
		? `VibeIDE checkpoint: ход ${meta.turnIndex}${meta.toolName ? ` (${meta.toolName})` : ''}`
		: 'VibeIDE checkpoint snapshot';
	const body = [
		`tree ${treeSha}`,
		meta.turnIndex !== undefined ? `turnIndex ${meta.turnIndex}` : undefined,
		meta.toolName ? `toolName ${meta.toolName}` : undefined,
		meta.threadId ? `threadId ${meta.threadId}` : undefined,
	].filter(Boolean).join('\n');
	return `${head}\n\n${body}`;
}

/**
 * Нужен ли новый снимок.
 *
 * Дерево того же содержания даёт тот же sha, поэтому ход, ничего не изменивший в рабочей папке
 * (агент только читал), не порождает второго объекта: возвращается предыдущий снимок. Это не
 * только экономия — одинаковые снимки подряд превращают историю ходов в шум, где не видно, какой
 * ход что-то сделал.
 */
export function shouldReuseSnapshot(newTree: string, previousTree: string | undefined): boolean {
	return previousTree !== undefined && previousTree.trim() === newTree.trim() && newTree.trim().length > 0;
}

/**
 * How long a snapshot is spared regardless of what the live set says.
 *
 * Threads are persisted with coalescing and a second window may have just created a checkpoint that
 * has not reached storage yet. Releasing that snapshot would destroy a rollback point nobody could
 * recreate, so recency wins over tidiness: the objects survive one more sweep, and the next one
 * collects them if they really are dead.
 */
export const SNAPSHOT_PRUNE_MIN_AGE_MS = 60 * 60 * 1000;

export interface PinnedSnapshot {
	readonly id: string;
	/** Commit time of the snapshot, ms since epoch. */
	readonly committedAtMs: number;
}

/** Parse `for-each-ref` output of the form `refs/vibe/checkpoints/<id> <unix-seconds>`. */
export function parsePinnedSnapshots(stdout: string): PinnedSnapshot[] {
	const out: PinnedSnapshot[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [name, stamp] = line.trim().split(/\s+/);
		if (!name || !name.startsWith(`${SNAPSHOT_REF_PREFIX}/`)) {
			continue;
		}
		const id = name.slice(SNAPSHOT_REF_PREFIX.length + 1);
		const seconds = Number(stamp);
		if (id.length === 0 || !Number.isFinite(seconds)) {
			continue;
		}
		out.push({ id, committedAtMs: seconds * 1000 });
	}
	return out;
}

/**
 * Snapshot ids safe to release: referenced by no checkpoint AND old enough that no window could
 * still be about to persist a checkpoint pointing at them.
 *
 * Deliberately computed from the LIVE set rather than from delete events: a missed event leaks
 * silently and forever, while a recomputed sweep is self-correcting. And deliberately conservative
 * in both directions — leaking a snapshot costs disk, releasing a live one costs a rollback.
 */
export function selectStaleSnapshotRefs(
	pinned: readonly PinnedSnapshot[],
	liveSnapshotIds: readonly string[],
	nowMs: number,
	minAgeMs: number = SNAPSHOT_PRUNE_MIN_AGE_MS,
): string[] {
	const live = new Set(liveSnapshotIds);
	return pinned
		.filter(p => !live.has(p.id) && nowMs - p.committedAtMs >= minAgeMs)
		.map(p => p.id);
}

/** A tree object id as printed by `git write-tree`. */
const TREE_ID_PATTERN = /^[0-9a-f]{40}$|^[0-9a-f]{64}$/;

export function isSnapshotTreeId(value: string | undefined): value is string {
	return typeof value === 'string' && TREE_ID_PATTERN.test(value.trim());
}

/** Split `git` output into non-empty lines. NUL-separated output is handled by the caller. */
export function parsePathList(stdout: string): string[] {
	return stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

/**
 * What restoring `snapshotPaths` over `currentPaths` would touch. Deletions are listed separately
 * because they are the destructive half: a file created after the checkpoint disappears, and no
 * git object holds it afterwards.
 */
export function planSnapshotRestore(
	snapshotPaths: readonly string[],
	currentPaths: readonly string[],
): SnapshotRestorePlan {
	const inSnapshot = new Set(snapshotPaths);
	return {
		restore: [...inSnapshot].sort(),
		delete: currentPaths.filter(p => !inSnapshot.has(p)).sort(),
	};
}
