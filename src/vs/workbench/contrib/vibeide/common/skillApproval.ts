/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Одобрение скилла по отпечатку всего его каталога.
 *
 * WHY the whole directory and not `SKILL.md`: the model reads the skill's text, but the agent runs
 * its scripts, and a script's source never reaches the model — only its output does (arXiv
 * 2604.02837). A fingerprint of `SKILL.md` alone approves the one file a reviewer reads and waves
 * through the ones that execute. The unit of integrity is the package: every file under the skill's
 * directory, by content and by name.
 *
 * WHY every change asks again: «approved once, trusted forever» is the gap the same paper names — a
 * skill approved on Monday whose script changed on Tuesday still runs with the user's authority. An
 * approval here is an approval of these bytes.
 *
 * Pure: fingerprints, the trust decision, the diff and the words for the dialog. Reading files and
 * keeping approvals belong to the skills library.
 */

import { localize } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { SkillOrigin, skillOriginLabel } from './vibeSkillProvenance.js';

/** A file's name and content hash — what an approval remembers about it. */
export interface SkillFileFingerprint {
	/** Path inside the package, `/`-separated; for a single-file skill — the file's own name. */
	readonly path: string;
	readonly sha256: string;
}

/** One file of a skill package. */
export interface SkillPackageFile extends SkillFileFingerprint {
	readonly size: number;
	/** Runs as code: a script by extension, a `#!` line, or a native binary. */
	readonly executable: boolean;
}

/** What the user approved: the fingerprint, and the files behind it so that a later change can be shown. */
export interface SkillApproval {
	readonly digest: string;
	readonly files: readonly SkillFileFingerprint[];
	readonly approvedAt: number;
}

export type SkillTrustState =
	/** Bundled with the product. */
	| 'builtin'
	/** Every file matches a revision the `.vibe` set published. */
	| 'shipped'
	/** The user approved exactly these bytes. */
	| 'approved'
	/** Approved before; the files differ now. */
	| 'changed'
	/** Never approved. */
	| 'new'
	/** Too large or unreadable to fingerprint — cannot be approved by digest. */
	| 'unverifiable';

export interface SkillPackageChanges {
	readonly added: readonly string[];
	readonly removed: readonly string[];
	readonly modified: readonly string[];
}

/** A skill's package as the library found it, and whether the model may see it. */
export interface VibeSkillPackage {
	/** The skill's directory — or the file itself for a single-file skill (`name.skill.md`). */
	readonly root: URI;
	readonly origin: SkillOrigin;
	readonly trust: SkillTrustState;
	/** Fingerprint of the whole package; absent when it could not be taken. */
	readonly digest?: string;
	readonly files: readonly SkillPackageFile[];
	/** What changed since the approval — present when `trust` is 'changed'. */
	readonly changes?: SkillPackageChanges;
	/** Why no fingerprint could be taken — present when `trust` is 'unverifiable'. */
	readonly unverifiableReason?: string;
	/** Config Guard findings about this skill, one message each; absent when the guard is off. */
	readonly findings?: readonly string[];
}

/** Recursion guard for the package walk: a link cycle inside a skill must not hang discovery. */
export const SKILL_PACKAGE_MAX_DEPTH = 8;

/** A package with more files than this is not fingerprinted by default (`vibeide.skills.approvalMaxFiles`). */
export const SKILL_APPROVAL_DEFAULT_MAX_FILES = 500;

/** A package larger than this is not fingerprinted by default (`vibeide.skills.approvalMaxMegabytes`). */
export const SKILL_APPROVAL_DEFAULT_MAX_MEGABYTES = 16;

/** The command that lists skills awaiting approval — named here because the library's notices point to it. */
export const SKILLS_REVIEW_COMMAND_ID = 'vibeide.skills.review';

/** Whether a stored value is an approval: storage outlives versions of this code and is read defensively. */
export function isSkillApproval(value: unknown): value is SkillApproval {
	if (!value || typeof value !== 'object') {
		return false;
	}
	const candidate = value as Partial<SkillApproval>;
	return typeof candidate.digest === 'string'
		&& typeof candidate.approvedAt === 'number'
		&& Array.isArray(candidate.files)
		&& candidate.files.every(file => !!file && typeof file.path === 'string' && typeof file.sha256 === 'string');
}

/** States in which the model may see the skill. */
export function isSkillTrusted(state: SkillTrustState): boolean {
	return state === 'builtin' || state === 'shipped' || state === 'approved';
}

/**
 * The trust decision, first match wins: bundled with the product; no fingerprint (cannot be vouched
 * for, so cannot be approved either); every file from the release; approved as it is now; approved
 * as it was; never approved.
 */
export function decideSkillTrust(input: {
	readonly builtin: boolean;
	readonly shipped: boolean;
	readonly digest: string | undefined;
	readonly approval: SkillApproval | undefined;
}): SkillTrustState {
	if (input.builtin) {
		return 'builtin';
	}
	if (input.digest === undefined) {
		return 'unverifiable';
	}
	if (input.shipped) {
		return 'shipped';
	}
	if (!input.approval) {
		return 'new';
	}
	return input.approval.digest === input.digest ? 'approved' : 'changed';
}

/** Hex SHA-256 of raw bytes — no line-ending normalisation: an approval is of the bytes that run. */
export async function sha256OfBytes(bytes: Uint8Array): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', bytes);
	return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

/**
 * The package fingerprint: SHA-256 over one `path NUL sha256` line per file, sorted by path. Names are
 * part of it, so a file renamed into `scripts/` is a change even when its bytes are not.
 */
export async function skillPackageDigest(files: readonly SkillFileFingerprint[]): Promise<string> {
	const listing = [...files]
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)
		.map(file => `${file.path}\u0000${file.sha256}\n`)
		.join('');
	return sha256OfBytes(new TextEncoder().encode(listing));
}

/** What changed between the approved files and the current ones, each list sorted. */
export function diffSkillPackage(approved: readonly SkillFileFingerprint[], current: readonly SkillFileFingerprint[]): SkillPackageChanges {
	const before = new Map(approved.map(file => [file.path, file.sha256]));
	const after = new Map(current.map(file => [file.path, file.sha256]));
	return {
		added: [...after.keys()].filter(path => !before.has(path)).sort(),
		removed: [...before.keys()].filter(path => !after.has(path)).sort(),
		modified: [...after].filter(([path, sha256]) => before.has(path) && before.get(path) !== sha256).map(([path]) => path).sort(),
	};
}

/** Extensions of files that run as code: scripts an agent would invoke, and native binaries. */
const EXECUTABLE_EXTENSIONS: ReadonlySet<string> = new Set([
	'sh', 'bash', 'zsh', 'fish', 'ksh', 'csh', 'command',
	'ps1', 'psm1', 'bat', 'cmd', 'vbs', 'wsf',
	'py', 'pyw', 'js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'rb', 'pl', 'php', 'lua', 'r', 'jl',
	'applescript', 'scpt', 'jar', 'exe', 'dll', 'so', 'dylib', 'wasm', 'msi',
]);

/** Magic numbers of native executables: ELF, PE, Mach-O in both byte orders, fat binaries and Java classes. */
const BINARY_MAGIC: readonly (readonly number[])[] = [
	[0x7f, 0x45, 0x4c, 0x46],
	[0x4d, 0x5a],
	[0xfe, 0xed, 0xfa, 0xce], [0xfe, 0xed, 0xfa, 0xcf],
	[0xce, 0xfa, 0xed, 0xfe], [0xcf, 0xfa, 0xed, 0xfe],
	[0xca, 0xfe, 0xba, 0xbe],
];

/**
 * Whether a file of a skill runs as code. `head` is the start of its content: an extensionless
 * script announces itself with `#!`, a binary with its magic number, and neither needs a name.
 */
export function isExecutableSkillFile(path: string, head: Uint8Array): boolean {
	const name = path.slice(path.lastIndexOf('/') + 1);
	const dot = name.lastIndexOf('.');
	if (dot > 0 && EXECUTABLE_EXTENSIONS.has(name.slice(dot + 1).toLowerCase())) {
		return true;
	}
	if (head.length >= 2 && head[0] === 0x23 && head[1] === 0x21) {
		return true;
	}
	return BINARY_MAGIC.some(magic => magic.length <= head.length && magic.every((byte, i) => head[i] === byte));
}

/** The trust state in words, for lists and dialogs. */
export function describeSkillTrust(state: SkillTrustState): string {
	switch (state) {
		case 'builtin': return localize('vibeide.skills.trust.builtin', "встроен в VibeIDE");
		case 'shipped': return localize('vibeide.skills.trust.shipped', "из релиза, не изменён");
		case 'approved': return localize('vibeide.skills.trust.approved', "одобрен вами");
		case 'changed': return localize('vibeide.skills.trust.changed', "изменился после одобрения");
		case 'new': return localize('vibeide.skills.trust.new', "ещё не одобрен");
		case 'unverifiable': return localize('vibeide.skills.trust.unverifiable', "не проверить — одобрить нельзя");
	}
}

/** How many names of a kind are listed before «и ещё N». */
const LISTED_NAMES = 6;

function listNames(names: readonly string[]): string {
	return names.length <= LISTED_NAMES
		? names.join(', ')
		: localize('vibeide.skills.approval.more', "{0} и ещё {1}", names.slice(0, LISTED_NAMES).join(', '), names.length - LISTED_NAMES);
}

/**
 * What the person is asked to approve, in lines: the state and the origin, what changed since the
 * last approval, the files that run as code, and what Config Guard said.
 *
 * The executable files are named on purpose. They are what the approval is really about — the model
 * will see their output and never their source — and a dialog that only says «скилл изменился» asks
 * for trust without saying in what.
 */
export function describeSkillForApproval(skillId: string, pkg: VibeSkillPackage): string {
	const lines = [localize('vibeide.skills.approval.head', "«{0}» — {1}; {2}", skillId, describeSkillTrust(pkg.trust), skillOriginLabel(pkg.origin))];
	if (pkg.unverifiableReason) {
		lines.push(pkg.unverifiableReason);
	}
	if (pkg.changes) {
		const { added, removed, modified } = pkg.changes;
		if (added.length > 0) {
			lines.push(localize('vibeide.skills.approval.added', "Добавлены: {0}", listNames(added)));
		}
		if (modified.length > 0) {
			lines.push(localize('vibeide.skills.approval.modified', "Изменены: {0}", listNames(modified)));
		}
		if (removed.length > 0) {
			lines.push(localize('vibeide.skills.approval.removed', "Удалены: {0}", listNames(removed)));
		}
	}
	if (pkg.trust !== 'unverifiable') {
		const executables = pkg.files.filter(file => file.executable).map(file => file.path);
		lines.push(executables.length > 0
			? localize('vibeide.skills.approval.executables', "Файлов: {0}, исполняемых: {1} — {2}. Модель увидит их вывод, но не код.", pkg.files.length, executables.length, listNames(executables))
			: localize('vibeide.skills.approval.noExecutables', "Файлов: {0}, исполняемых нет.", pkg.files.length));
	}
	for (const finding of pkg.findings ?? []) {
		lines.push(localize('vibeide.skills.approval.finding', "Config Guard: {0}", finding));
	}
	return lines.join('\n');
}
