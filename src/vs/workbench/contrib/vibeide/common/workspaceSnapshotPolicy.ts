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
 *
 * The format is shared with VibeIDEA: a snapshot taken by one product must be readable by the other.
 * The contract is `checkpointSpec.md` of the shared `.vibe-defaults` set and its test vectors are
 * `testVectors/checkpoint.json`; this module is pinned to them by `test/node/checkpointVectors.test.ts`.
 */

/** Files git reports, split by how the restore must treat them. */
export interface SnapshotRestorePlan {
	/** Paths present in the snapshot: overwritten from it. */
	readonly restore: readonly string[];
	/** Paths absent from the snapshot but present now: deleted by the restore. */
	readonly delete: readonly string[];
}

/** Product name in the snapshot subject and in the commit identity. */
export const SNAPSHOT_PRODUCT = 'VibeIDE';

/** The `agent` field of a snapshot taken during a turn of the built-in agent; an ACP agent writes its registry id. */
export const SNAPSHOT_AGENT_BUILTIN = 'builtin';

/**
 * Author and committer of a snapshot commit, set through the environment of `commit-tree`.
 * The address is the product name in lower case, as the contract defines it.
 */
export function snapshotIdentity(product: string = SNAPSHOT_PRODUCT): Readonly<Record<string, string>> {
	const email = `snapshot@${product.toLowerCase()}.local`;
	return {
		GIT_AUTHOR_NAME: product,
		GIT_AUTHOR_EMAIL: email,
		GIT_COMMITTER_NAME: product,
		GIT_COMMITTER_EMAIL: email,
	};
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
	/**
	 * Paths where the temporary index (after `add -A`) differs from the snapshot: changed, created
	 * and deleted since. `-z` because git quotes names with non-ASCII characters otherwise, and
	 * `--no-renames` so both sides of a move are listed.
	 */
	changedSinceSnapshot: (commit: string) => ['diff', '--cached', '--name-only', '-z', '--no-renames', commit, '--'],
	/** Write the temporary index out over the working tree. */
	checkoutIndex: ['checkout-index', '-a', '-f'],
	// `-z` on both listings: without it git wraps a name with non-ASCII characters in quotes, such a
	// path is not found on disk, and the `rm` of the restore silently does nothing
	listTree: (tree: string) => ['ls-tree', '-r', '-z', '--name-only', tree],
	/** Everything git currently considers part of the working set, ignored files excluded. */
	listWorking: ['ls-files', '-z', '--cached', '--others', '--exclude-standard'],
	/** Pinned snapshots with the age of each, so a young one can be spared. */
	listSnapshotRefs: ['for-each-ref', '--format=%(refname) %(committerdate:unix)', SNAPSHOT_REF_PREFIX],
	deleteRef: (id: string) => ['update-ref', '-d', snapshotRefName(id)],
	/** Tree behind an existing snapshot commit — the basis for skipping an unchanged turn. */
	treeOfCommit: (commit: string) => ['rev-parse', `${commit}^{tree}`],
} as const;

/** What is known about the turn at the moment of the snapshot. Everything is optional: a snapshot is worth having unsigned. */
export interface SnapshotCommitMeta {
	/** Ordinal number of the turn in the thread, from 0. */
	readonly turnIndex?: number;
	/** Tool after which the snapshot was taken, when it is tied to one. */
	readonly toolName?: string;
	readonly threadId?: string;
	/** `builtin` for the built-in agent, the registry id for an ACP agent. */
	readonly agent?: string;
	/** A one-line caption for a timeline. */
	readonly label?: string;
}

/** The fields a reader gets back from a snapshot message; only those that were found are present. */
export interface SnapshotMessageFields {
	readonly tree?: string;
	readonly turnIndex?: number;
	readonly toolName?: string;
	readonly threadId?: string;
	readonly agent?: string;
	readonly label?: string;
}

/** Any run of whitespace, line breaks included, becomes one space: a value cannot smuggle in a line of its own. */
function toOneLine(value: string): string {
	return value.replace(/\s+/g, ' ').trim();
}

/** A non-negative integer turn number, or `undefined` for anything else. */
function validTurnIndex(value: number | undefined): number | undefined {
	return value !== undefined && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/**
 * Message of a snapshot commit, in the form the contract defines (`checkpointSpec.md`, section 7).
 *
 * The first line is short — `git log --oneline` shows it — and names the turn and the tool, so that
 * `git log refs/vibe/checkpoints/*` reads as a history of the agent's work rather than a column of
 * identical phrases. The body is `key: value` lines, one per field; a field without a value is not
 * written. The time is not in the message: it is the committer date.
 */
export function snapshotCommitMessage(treeSha: string, meta: SnapshotCommitMeta = {}, product: string = SNAPSHOT_PRODUCT): string {
	const turnIndex = validTurnIndex(meta.turnIndex);
	const toolName = meta.toolName === undefined ? '' : toOneLine(meta.toolName);
	const head = turnIndex !== undefined
		? `${product} checkpoint: ход ${turnIndex} (${toolName || 'agent'})`
		: `${product} checkpoint snapshot`;
	const fields: ReadonlyArray<readonly [string, string | undefined]> = [
		['tree', treeSha],
		['turnIndex', turnIndex?.toString()],
		['toolName', toolName],
		['threadId', meta.threadId],
		['agent', meta.agent],
		['label', meta.label],
	];
	const body = fields
		.map(([key, value]) => [key, toOneLine(value ?? '')] as const)
		.filter(([, value]) => value.length > 0)
		.map(([key, value]) => `${key}: ${value}`)
		.join('\n');
	return `${head}\n\n${body}`;
}

/** `key: value` — the key is Latin letters and digits starting with a letter, the separator is the first colon followed by a space. */
const MESSAGE_FIELD = /^([A-Za-z][A-Za-z0-9]*): (.*)$/;

/** The legacy form `key value`, written before the contract. */
const MESSAGE_FIELD_LEGACY = /^([A-Za-z][A-Za-z0-9]*)\s+(.*)$/;

const MESSAGE_FIELD_KEYS: ReadonlySet<string> = new Set(['tree', 'turnIndex', 'toolName', 'threadId', 'agent', 'label']);

/**
 * Fields of a snapshot message — the reader of the contract (section 7.4).
 *
 * Never throws on a message it does not understand: what is not there is simply absent. Unknown keys
 * are skipped silently because the contract may grow; a repeated key keeps its first occurrence.
 * The legacy `key value` lines (no colon) are read for known keys only, so snapshots taken before
 * the contract stay readable.
 */
export function parseSnapshotCommitMessage(message: string): SnapshotMessageFields {
	const raw = new Map<string, string>();
	// The first line is the subject; it is not parsed
	for (const line of message.split(/\r?\n/).slice(1)) {
		const text = line.trim();
		if (text.length === 0) { continue; }
		const current = MESSAGE_FIELD.exec(text);
		const legacy = current ? undefined : MESSAGE_FIELD_LEGACY.exec(text);
		const match = current ?? legacy;
		if (!match) { continue; }
		const key = match[1];
		const value = match[2].trim();
		if (!MESSAGE_FIELD_KEYS.has(key) || value.length === 0 || raw.has(key)) { continue; }
		raw.set(key, value);
	}
	const turnIndex = raw.has('turnIndex') && /^\d+$/.test(raw.get('turnIndex')!) ? validTurnIndex(Number(raw.get('turnIndex'))) : undefined;
	return {
		...(raw.has('tree') ? { tree: raw.get('tree') } : {}),
		...(turnIndex === undefined ? {} : { turnIndex }),
		...(raw.has('toolName') ? { toolName: raw.get('toolName') } : {}),
		...(raw.has('threadId') ? { threadId: raw.get('threadId') } : {}),
		...(raw.has('agent') ? { agent: raw.get('agent') } : {}),
		...(raw.has('label') ? { label: raw.get('label') } : {}),
	};
}

/**
 * Нужен ли новый снимок.
 *
 * Дерево того же содержания даёт тот же sha, поэтому ход, ничего не изменивший в рабочей папке
 * (агент только читал), не порождает второго объекта: возвращается предыдущий снимок. Это не
 * только экономия — одинаковые снимки подряд превращают историю ходов в шум, где не видно, какой
 * ход что-то сделал.
 */
export function shouldReuseSnapshot(newTree: string, previousTree: string | null | undefined): boolean {
	return typeof previousTree === 'string' && previousTree.trim() === newTree.trim() && newTree.trim().length > 0;
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

/**
 * Split line-based `git` output into non-empty lines. Only for names that cannot contain a line break
 * or non-ASCII characters (branches, refs): file paths come from `-z` output through `parseNulList` (worktreeIncludePolicy).
 */
export function parsePathList(stdout: string): string[] {
	return stdout.split(/\r?\n/).map(l => l.trim()).filter(l => l.length > 0);
}

/**
 * What restoring `snapshotPaths` over `currentPaths` would touch. Deletions are listed separately
 * because they are the destructive half: a file created after the checkpoint disappears, and no
 * git object holds it afterwards.
 *
 * `currentPaths` is what git counts as part of the folder (ignored files are not in it), so the
 * ignored ones can never land in `delete`. Both lists are sorted by UTF-16 code units, without repeats.
 */
export function planSnapshotRestore(
	snapshotPaths: readonly string[],
	currentPaths: readonly string[],
): SnapshotRestorePlan {
	const inSnapshot = new Set(snapshotPaths);
	return {
		restore: [...inSnapshot].sort(),
		delete: [...new Set(currentPaths.filter(p => !inSnapshot.has(p)))].sort(),
	};
}
