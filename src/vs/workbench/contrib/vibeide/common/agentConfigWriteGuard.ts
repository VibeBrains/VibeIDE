/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Какие пути агент не правит своими инструментами.
 *
 * WHY this is a separate pure module: the agent's own configuration decides what it may do next —
 * hooks, commands, agents, pipelines, roles, providers, MCP servers, the environment file and the
 * skills/rules/providers folders. A write tool that can edit them is a write tool that can widen its
 * own permissions, so the refusal has to be a property of the PATH, not of a particular tool.
 *
 * The person keeps editing these files as before: the guard lives on the agent's write path only.
 *
 * No I/O and no VS Code dependencies — the caller passes workspace roots, home and token storage
 * locations. Paths are brought to one spelling BEFORE comparison: backslashes, `//`, `.` and `..`
 * are resolved first, and on macOS/Windows the comparison folds case (a deny may only err towards
 * refusing).
 */

import { localize } from '../../../../nls.js';

/** One protected-name set per `.vibe` folder: files directly inside it, and folders under it. */
const PROTECTED_VIBE_FILES: ReadonlySet<string> = new Set([
	'hooks.json',
	'commands.json',
	'agents.json',
	'pipelines.json',
	'roles.json',
	'providers.json',
	'mcp.json',
	'.env',
]);

/** A folder with this name under `.vibe` is protected together with everything inside it. */
const PROTECTED_VIBE_FOLDERS: ReadonlySet<string> = new Set(['skills', 'rules', 'providers']);

/** Where VibeMemory keeps the team tokens an MCP helper prints — the one MCP token store on disk. */
const VIBE_MEMORY_TOKEN_SEGMENTS: readonly string[] = ['.vibememory', 'tokens'];

/** The folder whose configuration belongs to the person, not to the agent. */
const VIBE_FOLDER = '.vibe';

export interface AgentConfigWriteGuardOptions {
	/** Корни проектов: у каждого свой `.vibe` */
	readonly workspaceRoots: readonly string[];
	/** Домашний каталог: там живёт общий `~/.vibe` */
	readonly home: string | undefined;
	/**
	 * Дополнительные корни хранилищ токенов (абсолютные пути). Не заданы — берётся
	 * `~/.vibememory/tokens`, где VibeMemory держит токены команд
	 */
	readonly tokenStorageRoots?: readonly string[];
	/**
	 * Сверять без учёта регистра. По умолчанию да: на APFS и NTFS `.VIBE` и `.vibe` — одна папка,
	 * а запрет, ошибившийся в сторону отказа, безопаснее пропуска
	 */
	readonly ignoreCase?: boolean;
}

/**
 * Причина, по которой путь защищён, или `undefined` для обычного файла.
 *
 * The result is the user-facing reason: callers throw it as the tool error, so the model and the
 * person read the same sentence.
 */
export function isProtectedAgentConfigPath(path: string, options: AgentConfigWriteGuardOptions): string | undefined {
	const ignoreCase = options.ignoreCase !== false;
	const targets = candidatePaths(path, options);
	if (targets.length === 0) {
		return undefined;
	}

	const vibeRoots = protectedVibeRoots(options);
	const tokenRoots = tokenStorageRoots(options);
	for (const target of targets) {
		for (const root of vibeRoots) {
			const relative = relativeUnder(root, target, ignoreCase);
			if (relative === undefined) {
				continue;
			}
			const segments = relative.split('/');
			const head = fold(segments[0], ignoreCase);
			// Сам каталог `.vibe` тоже защищён: удалить или пересоздать его — та же правка конфигурации
			const isRoot = relative === '';
			const isFile = segments.length === 1 && PROTECTED_VIBE_FILES.has(head);
			const isFolder = PROTECTED_VIBE_FOLDERS.has(head);
			if (isRoot || isFile || isFolder) {
				return localize('vibeide.agentConfigWriteGuard.config', "Запись в {0} отклонена: это конфигурация агента, её правит человек в IDE, а не инструменты агента.", path);
			}
		}
		for (const root of tokenRoots) {
			if (relativeUnder(root, target, ignoreCase) !== undefined) {
				return localize('vibeide.agentConfigWriteGuard.tokens', "Запись в {0} отклонена: это хранилище токенов MCP, его правит человек в IDE, а не инструменты агента.", path);
			}
		}
	}
	return undefined;
}

/** Every spelling a relative path may have: one per workspace root; an absolute path stands alone. */
function candidatePaths(path: string, options: AgentConfigWriteGuardOptions): string[] {
	const expanded = expandHome(path, options.home);
	if (isAbsolutePath(expanded)) {
		return [normalizePath(expanded)];
	}
	const roots = options.workspaceRoots.length > 0 ? options.workspaceRoots : [''];
	return roots.map(root => normalizePath(root ? `${root}/${expanded}` : expanded));
}

function protectedVibeRoots(options: AgentConfigWriteGuardOptions): string[] {
	const roots = options.workspaceRoots.map(root => normalizePath(`${root}/${VIBE_FOLDER}`));
	if (options.home) {
		roots.push(normalizePath(`${options.home}/${VIBE_FOLDER}`));
	}
	return roots;
}

function tokenStorageRoots(options: AgentConfigWriteGuardOptions): string[] {
	if (options.tokenStorageRoots) {
		return options.tokenStorageRoots.map(normalizePath);
	}
	return options.home ? [normalizePath(`${options.home}/${VIBE_MEMORY_TOKEN_SEGMENTS.join('/')}`)] : [];
}

function relativeUnder(root: string, target: string, ignoreCase: boolean): string | undefined {
	const r = fold(root, ignoreCase);
	const t = fold(target, ignoreCase);
	if (t === r) {
		return '';
	}
	const prefix = r.endsWith('/') ? r : `${r}/`;
	return t.startsWith(prefix) ? t.slice(prefix.length) : undefined;
}

function fold(value: string, ignoreCase: boolean): string {
	return ignoreCase ? value.toLowerCase() : value;
}

function expandHome(path: string, home: string | undefined): string {
	if (!home) {
		return path;
	}
	if (path === '~' || path.startsWith('~/') || path.startsWith('~\\')) {
		return `${home}/${path.slice(1).replace(/^[\\/]+/, '')}`;
	}
	return path;
}

function isAbsolutePath(path: string): boolean {
	return path.startsWith('/') || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * One spelling for comparison: forward slashes, no `.`/`..`, no repeated separators.
 *
 * Backslashes become slashes on EVERY platform on purpose: a Windows path handed to a POSIX build
 * must not turn into one long file name and slip past the guard.
 */
function normalizePath(path: string): string {
	const slashed = path.trim().replace(/\\/g, '/').replace(/\/+/g, '/');
	const drive = /^([A-Za-z]):\//.exec(slashed);
	const prefix = drive ? `${drive[1].toLowerCase()}:/` : slashed.startsWith('/') ? '/' : '';
	const rest = drive ? slashed.slice(3) : slashed.replace(/^\/+/, '');
	const segments: string[] = [];
	for (const segment of rest.split('/')) {
		if (!segment || segment === '.') {
			continue;
		}
		if (segment === '..') {
			if (segments.length > 0 && segments[segments.length - 1] !== '..') {
				segments.pop();
			} else if (!prefix) {
				segments.push('..');
			}
			continue;
		}
		segments.push(segment);
	}
	return prefix + segments.join('/');
}
