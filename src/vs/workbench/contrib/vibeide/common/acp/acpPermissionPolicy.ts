/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who answers an external agent's question: the person, or the mode the person chose for this conversation
 *
 * The agent asks before an edit or a command, and its answer options are its own. Two things are decided here, apart
 * from the agent: what the person's mode and the permissions given for the session answer by themselves, and what is
 * never answered without the person — an irreversible command, a path outside the project
 *
 * Irreversible is judged in the project's terms: removal inside the project (a checkpoint stands under it) and inside
 * temporary folders loses nothing, so it is left to the mode; removal anywhere else, a forced push and code fetched
 * from the network are asked whatever the mode says
 *
 * The mode the person picks (Вручную, Правки, План, Автопилот) is set on the agent where the agent can keep it, and
 * is enforced here for the rest: in the agent's own «auto» and «bypass» modes it asks nothing at all, so a command
 * that cannot be undone, or an edit with no checkpoint under it, would go through unseen. That is why only `plan` is
 * set on the agent as such; the other three keep it asking, and this policy answers for the person
 *
 * Pure: the caller passes the facts of the question and gets a verdict
 */

import { analyzeShellLine, analyzeShellLineIn, programOf, splitShellSegments } from '../nlShellSafetyAnalyzer.js';
import { IShellRemovalScopeOptions, createShellRemovalScope } from '../shellRemovalScope.js';
import { IAcpConfigChoice } from './acpProtocol.js';

/**
 * The person's mode for a conversation led by an external agent
 * - `manual`: every question goes to the person
 * - `edits`: edits inside the project are allowed without a question, the rest asks
 * - `plan`: the agent plans and changes nothing; whatever it asks still goes to the person
 * - `auto`: everything is allowed without a question except what cannot be undone and what leaves the project
 */
export type AcpPermissionMode = 'manual' | 'edits' | 'plan' | 'auto';

export const ACP_PERMISSION_MODES: readonly AcpPermissionMode[] = ['manual', 'edits', 'plan', 'auto'];

export const DEFAULT_ACP_PERMISSION_MODE: AcpPermissionMode = 'manual';

/** A permission the person gave for the rest of the session */
export type AcpGrant =
	/** Every call of one tool: the agent's own name for it, or its kind when it sent no name */
	| { readonly kind: 'tool'; readonly tool: string }
	/** Simple commands that begin with these words */
	| { readonly kind: 'command'; readonly prefix: string }
	/** Edits of files under this folder */
	| { readonly kind: 'folder'; readonly folder: string };

/** What a question says about the call, as far as the policy needs it */
export interface IAcpRequestFacts {
	readonly toolKind: string;
	readonly name: string;
	readonly title: string;
	/** The command line of a shell call, when the agent sent it */
	readonly command: string;
	readonly paths: readonly string[];
}

export type AcpDecisionReason =
	/** Cannot be undone: asked whatever the mode and the grants say */
	| 'irreversible'
	/** A command whose text the agent did not send, so it cannot be judged */
	| 'unknownCommand'
	| 'outsideProject'
	| 'grant'
	| 'modeAuto'
	| 'modeEdits'
	| 'modeManual'
	| 'modePlan';

export interface IAcpDecision {
	readonly action: 'allow' | 'ask';
	readonly reason: AcpDecisionReason;
}

export interface IAcpDecisionContext {
	readonly mode: AcpPermissionMode;
	readonly grants: readonly AcpGrant[];
	/** The folders of the project: an edit outside them is not the project's */
	readonly roots: readonly string[];
	/** Where the agent's commands run; the first folder of the project when not given */
	readonly cwd?: string;
}

/** ACP kinds that change files */
const FILE_CHANGING_KINDS: ReadonlySet<string> = new Set(['edit', 'delete', 'move']);

/** Kinds whose paths must lie in the project: reading a key outside it is as much a step out as writing there */
const PATH_BOUND_KINDS: ReadonlySet<string> = new Set([...FILE_CHANGING_KINDS, 'read', 'search']);

/** Kinds an edit mode lets through: a rename is as much an edit as a change of text */
const EDIT_MODE_KINDS: ReadonlySet<string> = new Set(['edit', 'move']);

const SHELL_KIND = 'execute';

/** Программы, которые только читают: их файлы-аргументы можно судить по границе проекта. */
const READ_ONLY_SHELL_PROGRAMS: ReadonlySet<string> = new Set([
	'cat', 'head', 'tail', 'less', 'more', 'grep', 'rg', 'sed', 'awk', 'cut', 'sort', 'uniq',
	'wc', 'diff', 'find', 'ls', 'stat', 'file', 'readlink', 'realpath', 'bat', 'fd', 'zcat',
	'bzcat', 'xzcat', 'rev', 'tac', 'nl', 'od', 'hexdump', 'xxd', 'strings', 'du', 'df',
]);

/**
 * Абсолютные пути из read-only команды. Только чтение, поэтому к путям применяется та же граница
 * проекта, что и к `Read`/`Glob`/`Grep`: `cat /etc/passwd` не должен быть проще, чем `Read /etc/passwd`.
 *
 * Относительные пути намеренно не трогаются: без раскрытия `cwd` их легко принять за внешние и
 * спрашивать лишнего; такой случай продолжает решаться режимом, как и раньше.
 */
function absoluteReadOnlyShellPaths(command: string): string[] {
	const paths: string[] = [];
	for (const segment of splitShellSegments(command)) {
		if (!READ_ONLY_SHELL_PROGRAMS.has(programOf(segment.command))) { continue; }
		for (const arg of segment.args) {
			if (arg.startsWith('/') || /^[A-Za-z]:[\\/]/.test(arg)) {
				paths.push(arg);
			}
		}
	}
	return [...new Set(paths)];
}

/** How an agent names its modes: the planning one, and the one that asks before it acts (Claude Code's `default`) */
const AGENT_PLAN_MODE = /plan/i;
const AGENT_ASKING_MODE = /default|manual/i;

/**
 * The value of the agent's own «mode» setting that matches ours, or `undefined` to leave the agent as it is
 * Only `plan` is set as such. The others keep the agent asking, because this policy is what answers (see the module note)
 * and a mode of the agent that never asks would take the checkpoint and the irreversible-command check away
 */
export function agentModeFor(mode: AcpPermissionMode, choices: readonly IAcpConfigChoice[]): string | undefined {
	const pattern = mode === 'plan' ? AGENT_PLAN_MODE : AGENT_ASKING_MODE;
	return choices.find(choice => pattern.test(choice.value))?.value ?? choices.find(choice => pattern.test(choice.name))?.value;
}

/**
 * True when the question is about a command that cannot be undone: removal, a forced push, code fetched and run
 *
 * With the project (`area`), removal that stays inside the project or a temporary folder is not counted:
 * the checkpoint covers the first, and nothing is lost in the second. Without it every removal is counted
 */
export function isIrreversible(facts: IAcpRequestFacts, area?: IShellRemovalScopeOptions): boolean {
	const line = commandLineOf(facts);
	if (line === undefined) { return false; }
	const found = area ? analyzeShellLineIn(line, createShellRemovalScope({ roots: area.roots, cwd: area.cwd ?? area.roots[0] })) : analyzeShellLine(line);
	return found !== undefined;
}

/** The command line the question is about: what the agent sent, else a title that is one (tool names do not run) */
function commandLineOf(facts: IAcpRequestFacts): string | undefined {
	if (facts.command) { return facts.command; }
	if (facts.toolKind !== SHELL_KIND) { return undefined; }
	const title = facts.title.trim().replace(/^`+|`+$/g, '');
	return title || undefined;
}

export function decidePermission(facts: IAcpRequestFacts, context: IAcpDecisionContext): IAcpDecision {
	const ask = (reason: AcpDecisionReason): IAcpDecision => ({ action: 'ask', reason });
	const allow = (reason: AcpDecisionReason): IAcpDecision => ({ action: 'allow', reason });

	if (facts.toolKind === SHELL_KIND) {
		if (commandLineOf(facts) === undefined) { return ask('unknownCommand'); }
		if (isIrreversible(facts, context)) { return ask('irreversible'); }
	}
	const paths = facts.toolKind === SHELL_KIND
		? [...new Set([...facts.paths, ...absoluteReadOnlyShellPaths(commandLineOf(facts) ?? '')])]
		: facts.paths;
	if ((PATH_BOUND_KINDS.has(facts.toolKind) || (facts.toolKind === SHELL_KIND && paths.length > 0)) && !pathsAreAllowed(paths, context)) {
		return ask('outsideProject');
	}
	if (context.grants.some(grant => grantMatches(grant, facts))) {
		return allow('grant');
	}
	switch (context.mode) {
		case 'auto':
			return allow('modeAuto');
		case 'edits':
			return EDIT_MODE_KINDS.has(facts.toolKind) && facts.paths.length > 0 ? allow('modeEdits') : ask('modeEdits');
		case 'plan':
			return ask('modePlan');
		case 'manual':
			return ask('modeManual');
	}
}

/** Every path is inside the project, or under a folder the person gave rights for */
function pathsAreAllowed(paths: readonly string[], context: IAcpDecisionContext): boolean {
	return paths.every(path =>
		context.roots.length === 0
		|| context.roots.some(root => isUnder(path, root))
		|| context.grants.some(grant => grant.kind === 'folder' && isUnder(path, grant.folder)));
}

/** `path` is `folder` itself or lies under it; separators of either style, case kept */
export function isUnder(path: string, folder: string): boolean {
	const normalize = (value: string) => value.replace(/\\/g, '/').replace(/\/+$/, '');
	const p = normalize(path);
	const f = normalize(folder);
	return p === f || p.startsWith(`${f}/`);
}

export function grantMatches(grant: AcpGrant, facts: IAcpRequestFacts): boolean {
	switch (grant.kind) {
		case 'tool':
			return (facts.name || facts.toolKind) === grant.tool;
		case 'command': {
			const line = commandLineOf(facts);
			return line !== undefined && isSimpleCommand(line) && (line.trim() === grant.prefix || line.trim().startsWith(`${grant.prefix} `));
		}
		case 'folder':
			return FILE_CHANGING_KINDS.has(facts.toolKind) && facts.paths.length > 0 && facts.paths.every(path => isUnder(path, grant.folder));
	}
}

/** What the person may give for the session for this question; empty when nothing safe can be named */
export function grantOffersFor(facts: IAcpRequestFacts, roots: readonly string[]): AcpGrant[] {
	const offers: AcpGrant[] = [];
	if (facts.toolKind === SHELL_KIND) {
		// A shell is not a tool to be allowed whole: the command's own beginning is the widest that is safe to name
		const line = commandLineOf(facts);
		const prefix = line ? commandPrefixOf(line) : undefined;
		if (prefix) { offers.push({ kind: 'command', prefix }); }
		return offers;
	}
	const tool = facts.name || facts.toolKind;
	if (tool) { offers.push({ kind: 'tool', tool }); }
	if (FILE_CHANGING_KINDS.has(facts.toolKind) && facts.paths.length > 0) {
		const folder = commonFolderOf(facts.paths, roots);
		if (folder) { offers.push({ kind: 'folder', folder }); }
	}
	return offers;
}

/** The deepest folder that holds all the paths and lies inside the project; none when they are spread over several roots */
function commonFolderOf(paths: readonly string[], roots: readonly string[]): string | undefined {
	const folders = paths.map(path => path.replace(/\\/g, '/').replace(/\/[^/]*$/, ''));
	const first = folders[0].split('/');
	let common = first.length;
	for (const folder of folders.slice(1)) {
		const parts = folder.split('/');
		common = Math.min(common, parts.length);
		for (let i = 0; i < common; i++) {
			if (parts[i] !== first[i]) { common = i; break; }
		}
	}
	const candidate = first.slice(0, common).join('/');
	return candidate && roots.some(root => isUnder(candidate, root)) ? candidate : undefined;
}

/** Programs whose first argument is a subcommand: `git status` is a different thing than `git push` */
const SUBCOMMAND_PROGRAMS: ReadonlySet<string> = new Set([
	'git', 'npm', 'pnpm', 'yarn', 'docker', 'kubectl', 'cargo', 'go', 'dotnet', 'gradle', 'mvn', 'poetry', 'uv', 'pip', 'brew',
]);

/** Programs that run whatever they are told, or raise rights, or reach the network: never named in a grant */
const NEVER_GRANTED_PROGRAMS: ReadonlySet<string> = new Set([
	'sudo', 'su', 'doas', 'sh', 'bash', 'zsh', 'fish', 'dash', 'cmd', 'powershell', 'pwsh', 'eval', 'exec', 'env', 'xargs', 'nohup', 'time',
	'ssh', 'scp', 'curl', 'wget', 'nc', 'ncat', 'npx', 'node', 'python', 'python3', 'deno', 'bun', 'ruby', 'perl',
]);

/** A command of one program with plain arguments: no operators, no substitution, no redirection, no new line */
export function isSimpleCommand(line: string): boolean {
	return /^[^;&|`$<>(){}\n\r]+$/.test(line.trim());
}

/**
 * The beginning of a command that a grant may name: the program, and its subcommand for `git`, `npm` and alike
 * `undefined` when the command is not simple or the program is one that must not be allowed in advance
 */
export function commandPrefixOf(line: string): string | undefined {
	if (!isSimpleCommand(line)) { return undefined; }
	const [program, second] = line.trim().split(/\s+/);
	if (!program || NEVER_GRANTED_PROGRAMS.has(program.toLowerCase())) { return undefined; }
	return SUBCOMMAND_PROGRAMS.has(program) && second && !second.startsWith('-') ? `${program} ${second}` : program;
}

// ── Words for the card ───────────────────────────────────────────────────────

/** An answer option of the agent, as it comes in the question */
export interface IAcpAnswerOption {
	readonly optionId: string;
	readonly name: string;
	readonly kind: string;
}

const OPTION_KIND_LABELS: Record<string, string> = {
	allow_once: 'Разрешить',
	allow_always: 'Разрешать всегда',
	reject_once: 'Отказать',
	reject_always: 'Всегда отказывать',
};

/**
 * The button of an option: the word for its kind, in Russian
 * Options are the agent's own and its names are English, so the kind carries the meaning
 * When the agent offers several options of one kind — «yes, and auto-accept edits», «yes, and ask each time» — the kind
 * alone would show two identical buttons, and the agent's own name tells them apart
 */
export function permissionOptionLabel(option: IAcpAnswerOption, siblings: readonly IAcpAnswerOption[]): string {
	const word = OPTION_KIND_LABELS[option.kind];
	if (!word) { return option.name; }
	return siblings.filter(other => other.kind === option.kind).length > 1 ? `${word}: ${option.name}` : word;
}

/** The option an automatic answer picks: a one-time allowance first, a standing one if there is no other; none — the person answers */
export function autoAnswerOptionOf(options: readonly IAcpAnswerOption[]): string | undefined {
	return options.find(option => option.kind === 'allow_once')?.optionId
		?? options.find(option => option.kind === 'allow_always')?.optionId;
}

/** The sentence for a grant in the menu of the card */
export function describeGrant(grant: AcpGrant): string {
	switch (grant.kind) {
		case 'tool': return `Любой вызов «${grant.tool}» в этой сессии`;
		case 'command': return `Команды, начинающиеся с «${grant.prefix}», в этой сессии`;
		case 'folder': return `Правки файлов в папке «${grant.folder}» в этой сессии`;
	}
}

/** Why a question reached the person although a mode or a grant could have answered, when that is worth saying */
export function describeAsking(reason: AcpDecisionReason): string | undefined {
	switch (reason) {
		case 'irreversible': return 'Команду нельзя отменить (удаление вне проекта и временных папок, принудительный пуш, код из сети), поэтому её не разрешают заранее ни режим, ни разрешения сессии.';
		case 'unknownCommand': return 'Агент не прислал текст команды, поэтому оценить её нечем.';
		case 'outsideProject': return 'Правка за пределами проекта: режим и разрешения сессии её не покрывают.';
		default: return undefined;
	}
}
