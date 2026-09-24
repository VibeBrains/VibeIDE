/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import type { IChangedFile } from './vibeideSCMTypes.js';

/**
 * The git side of a pipeline's diff: where its snapshots are pinned, the argument vectors, and how git's
 * answers are read.
 *
 * Pure — the process spawning lives in the main-process service; the decisions live here so they are
 * testable.
 */

/** Pipeline snapshots live apart from the checkpoints' (`refs/vibe/checkpoints`), whose hourly sweep would release them. */
export const PIPELINE_SNAPSHOT_REF_PREFIX = 'refs/vibe/pipelines';

/** How old a run's pins must be to count as left behind: longer than any run, off-peak waits included. */
export const PIPELINE_SNAPSHOT_STALE_MS = 24 * 60 * 60 * 1000;

/** Paths per `git diff` call — well inside any platform's argument limit, rename pairs kept together. */
export const DIFF_PATHS_PER_CALL = 200;

/** A run id or a label: what may stand in a ref name as it is. */
const REF_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** The ref a pipeline snapshot is pinned under. Throws on a name git would refuse or read as something else. */
export function pipelineSnapshotRef(run: string, label: string): string {
	if (!REF_COMPONENT.test(run) || !REF_COMPONENT.test(label)) {
		throw new Error(`Недопустимое имя снимка пайплайна: ${run}/${label}`);
	}
	return `${PIPELINE_SNAPSHOT_REF_PREFIX}/${run}/${label}`;
}

/**
 * Whether `branch` can be handed to git as a revision: an agent branch name (`worktreeBranchName`) and
 * nothing that could be read as an option or a range.
 */
export function isSafeBranchName(branch: string): boolean {
	return /^[\p{L}\p{N}][\p{L}\p{N}._/-]*$/u.test(branch) && !branch.includes('..') && !branch.endsWith('.lock');
}

/** First line of a pipeline snapshot commit, then its tree — readable in `git log refs/vibe/pipelines`. */
export function pipelineSnapshotMessage(run: string, label: string, tree: string): string {
	return `VibeIDE pipeline snapshot: ${run} ${label}\n\ntree ${tree}`;
}

/** Argv (without the leading `git`). */
export const CHANGES_ARGV = {
	/** Where the working folder sits inside the repository: `packages/app/`, or empty at the root. */
	showPrefix: ['rev-parse', '--show-prefix'],
	treeOf: (revision: string) => ['rev-parse', '--verify', '--quiet', `${revision}^{tree}`],
	/** Where an agent branch forked: its own work is the diff from here to its tip. */
	mergeBase: (branch: string) => ['merge-base', 'HEAD', branch],
	/** Point the run's ref at its snapshot commit, so the snapshot stays reachable while the run lasts. */
	pinRef: (ref: string, commit: string) => ['update-ref', ref, commit],
	listRunRefs: ['for-each-ref', '--format=%(refname) %(committerdate:unix)', PIPELINE_SNAPSHOT_REF_PREFIX],
	deleteRef: (ref: string) => ['update-ref', '-d', ref],
	/** NUL-separated: paths come verbatim, whatever characters they hold. */
	nameStatus: (from: string, to: string) => ['diff', '--name-status', '-z', '-M', from, to],
	/**
	 * The patch a judge reads. Paths unquoted so a Cyrillic name stays readable; pathspecs literal so a
	 * file named `*.ts` is that file and not a pattern; external diff and textconv off, because what they
	 * print is the user's tool's view, not the change; a deleted file by its header only, because its
	 * whole old text says nothing a judge can act on.
	 */
	patch: (from: string, to: string, paths: readonly string[]) => [
		'-c', 'core.quotePath=false', '--literal-pathspecs',
		'diff', '--no-color', '--no-ext-diff', '--no-textconv', '-M', '--irreversible-delete', from, to, '--', ...paths,
	],
} as const;

/** `git diff --name-status -z` → the changed files. */
export function parseNameStatusZ(stdout: string): IChangedFile[] {
	const fields = stdout.split('\0');
	const files: IChangedFile[] = [];
	let i = 0;
	while (i < fields.length) {
		const code = fields[i];
		if (!code) {
			i++;
			continue;
		}
		const kind = code[0];
		if (kind === 'R' || kind === 'C') {
			const oldPath = fields[i + 1];
			const path = fields[i + 2];
			if (oldPath && path) {
				files.push({ status: kind === 'R' ? 'renamed' : 'copied', path, oldPath });
			}
			i += 3;
			continue;
		}
		const path = fields[i + 1];
		if (path) {
			files.push({ status: kind === 'A' ? 'added' : kind === 'D' ? 'deleted' : 'modified', path });
		}
		i += 2;
	}
	return files;
}

/** Every path a file's patch needs in the pathspec: both ends of a rename, or git sees a deletion and an addition. */
export function pathspecOf(file: IChangedFile): string[] {
	return file.oldPath ? [file.oldPath, file.path] : [file.path];
}

/** Files in groups for one `git diff` call each, a rename's two paths never split. */
export function chunkChangedFiles(files: readonly IChangedFile[], maxPaths: number = DIFF_PATHS_PER_CALL): IChangedFile[][] {
	const chunks: IChangedFile[][] = [];
	let current: IChangedFile[] = [];
	let paths = 0;
	for (const file of files) {
		const size = pathspecOf(file).length;
		if (current.length > 0 && paths + size > maxPaths) {
			chunks.push(current);
			current = [];
			paths = 0;
		}
		current.push(file);
		paths += size;
	}
	if (current.length > 0) {
		chunks.push(current);
	}
	return chunks;
}

/**
 * A patch split into one section per file.
 *
 * A section starts at a `diff --git ` line; a line of content never does, because git prefixes every
 * content line with a space, `+` or `-`.
 */
export function splitPatchSections(patch: string): string[] {
	const starts: number[] = [];
	const header = /^diff --git /gm;
	for (let match = header.exec(patch); match; match = header.exec(patch)) {
		starts.push(match.index);
	}
	return starts.map((start, i) => `${patch.slice(start, i + 1 < starts.length ? starts[i + 1] : patch.length).replace(/\n+$/, '')}\n`);
}

export interface PinnedRunRef {
	readonly ref: string;
	readonly run: string;
	readonly committedAtMs: number;
}

/** Parse `for-each-ref` output of the form `refs/vibe/pipelines/<run>/<label> <unix-seconds>`. */
export function parsePipelineRunRefs(stdout: string): PinnedRunRef[] {
	const out: PinnedRunRef[] = [];
	for (const line of stdout.split(/\r?\n/)) {
		const [ref, stamp] = line.trim().split(/\s+/);
		if (!ref || !ref.startsWith(`${PIPELINE_SNAPSHOT_REF_PREFIX}/`)) {
			continue;
		}
		const run = ref.slice(PIPELINE_SNAPSHOT_REF_PREFIX.length + 1).split('/')[0];
		const seconds = Number(stamp);
		if (!run || !Number.isFinite(seconds)) {
			continue;
		}
		out.push({ ref, run, committedAtMs: seconds * 1000 });
	}
	return out;
}

/**
 * Refs of the runs whose every pin is older than `minAgeMs`: a run that pinned anything recently is alive
 * in some window, and releasing its base would take the diff from under its judges.
 */
export function selectStaleRunRefs(refs: readonly PinnedRunRef[], nowMs: number, minAgeMs: number = PIPELINE_SNAPSHOT_STALE_MS): { readonly refs: string[]; readonly runs: number } {
	const newest = new Map<string, number>();
	for (const ref of refs) {
		newest.set(ref.run, Math.max(newest.get(ref.run) ?? 0, ref.committedAtMs));
	}
	const stale = new Set([...newest].filter(([, at]) => nowMs - at >= minAgeMs).map(([run]) => run));
	return { refs: refs.filter(ref => stale.has(ref.run)).map(ref => ref.ref), runs: stale.size };
}
