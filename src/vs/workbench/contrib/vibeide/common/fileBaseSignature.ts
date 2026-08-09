/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { StringSHA1 } from '../../../../base/common/hash.js';

/**
 * Pre-apply verification: proof that the file the agent is about to edit is still the file it read.
 *
 * The existing edit-safety pre-flights answer "did the model look at this file at all" — they do
 * nothing about the window between the read and the write. In that window the user types in the
 * editor, another agent edits the same file, a build regenerates it, `git checkout` swaps the
 * branch. The SEARCH side of the edit then either misses (loud, recoverable) or, worse, matches a
 * line that means something different now (silent, and the user's change is gone).
 *
 * A signature is captured at read time and re-checked immediately before applying an edit.
 *
 * Pure by design: the hash and the verdict are computed here, so the rule is testable without a
 * file system, a model service or a workbench.
 */

/** Where the content the agent saw actually came from. */
export type FileBaseSource = 'buffer' | 'disk';

/** What the agent read, and from where. */
export interface FileBaseSignature {
	/** Hash of the full file content as the agent saw it (LF-normalised). */
	readonly hash: string;
	/**
	 * `buffer` when an editor model was open (so unsaved user edits were included), `disk` otherwise.
	 *
	 * Kept because comparing a buffer against a file on disk is not a real conflict: a file that is
	 * merely unsaved differs from its disk copy by definition, and a check that ignored the source
	 * would refuse every edit to an open, dirty file. Comparison is only meaningful between two
	 * readings taken the same way — which is why the verdict below reports a source switch instead
	 * of pretending to compare.
	 */
	readonly source: FileBaseSource;
}

export type FileBaseVerdict =
	/** Same content, same source — safe to apply. */
	| { readonly kind: 'unchanged' }
	/** Content changed under the agent since it read the file. */
	| { readonly kind: 'changed' }
	/**
	 * Read from one source, about to write against the other (editor opened or closed in between).
	 * Content may well be identical, but equal hashes across sources prove nothing about the other
	 * one, so this is reported separately and treated as "re-read" rather than silently allowed.
	 */
	| { readonly kind: 'source-changed'; readonly from: FileBaseSource; readonly to: FileBaseSource }
	/** Nothing was recorded for this file — a different pre-flight ("must read first") covers that. */
	| { readonly kind: 'no-baseline' };

/** Hash of file content. Callers must pass LF-normalised text so line endings alone never differ. */
export function hashFileBase(content: string): string {
	const sha = new StringSHA1();
	sha.update(content);
	return sha.digest();
}

export function captureFileBase(content: string, source: FileBaseSource): FileBaseSignature {
	return { hash: hashFileBase(content), source };
}

/**
 * Compare what the agent read against what is there now.
 *
 * A differing hash wins over a differing source: if the content changed, saying so is more useful
 * to the model than reporting that the editor was opened meanwhile.
 */
export function verifyFileBase(
	recorded: FileBaseSignature | undefined,
	current: FileBaseSignature,
): FileBaseVerdict {
	if (!recorded) {
		return { kind: 'no-baseline' };
	}
	if (recorded.hash !== current.hash) {
		return { kind: 'changed' };
	}
	if (recorded.source !== current.source) {
		return { kind: 'source-changed', from: recorded.source, to: current.source };
	}
	return { kind: 'unchanged' };
}

/** Whether a verdict must stop the write. */
export function blocksApply(verdict: FileBaseVerdict): boolean {
	return verdict.kind === 'changed' || verdict.kind === 'source-changed';
}
