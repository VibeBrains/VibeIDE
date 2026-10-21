/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Область безопасного удаления для разбора командной строки
 *
 * `rm -rf $(mktemp -d …)` в конце скрипта и `rm -rf dist` в проекте под чекпоинтом — не потеря данных
 * Классификатор `analyzeShellLine` этого не знает: для него любое `rm` разрушительно
 * Область отвечает на один вопрос: все ли цели удаления лежат во временных каталогах или в проекте
 *
 * Разрешение здесь выдаётся молча, поэтому всё неясное читается как «нет»:
 * - относительный путь, пока неизвестно, где командная строка стоит
 * - путь с `..`, переменная неизвестного происхождения, подстановка команды, `~`
 * - сам корень области и всё, что может оказаться `.git` (там чекпоинты)
 *
 * Разбор поверхностный, как и у классификатора: оболочку целиком он не исполняет
 * Поэтому среда отслеживается только по прямой цепочке простых команд
 * Любой признак, что среду меняют иначе (`eval`, `source`, `read`, группа `{ … }`), снимает доверие к ней
 *
 * Чистая: без обращений к файловой системе и окружению
 */

import { IShellLineScope, ShellSafetyResult, parseShellLine, programOf } from './nlShellSafetyAnalyzer.js';

/** Временные каталоги, потеря содержимого которых потерей не считается */
const TEMP_ROOTS: readonly string[] = ['/tmp', '/private/tmp', '/var/tmp', '/private/var/tmp', '/var/folders', '/private/var/folders'];

/** Временные каталоги Windows: `C:\Users\<имя>\AppData\Local\Temp`, `C:\Windows\Temp` (путь уже с прямыми слэшами) */
const WINDOWS_TEMP = /^[a-z]:\/(?:users\/[^/]+\/appdata\/local|windows)\/temp\/(.*)$/i;

/** Чем подменяется `$TMPDIR` и родственные: каталог и так временный, его настоящее значение не нужно */
const TEMP_STAND_IN = '/tmp';

/** Переменные, которые по определению указывают во временный каталог */
const TEMP_VARIABLES: ReadonlySet<string> = new Set(['TMPDIR', 'TMP', 'TEMP']);

/** Причины разрушительности, которые область умеет снимать: только само удаление, без корня, `~` и `*` */
const REMOVAL_REASONS: ReadonlySet<string> = new Set(['rm-binary', 'force-flag', 'rf-flag', 'fr-flag']);

/**
 * Команда удаления, чьи цели область умеет читать
 * PowerShell (`Remove-Item`) не читается: разбор строки ведётся по правилам POSIX, и обратная косая черта
 * в пути `C:\Windows\Temp` для него — экранирование, так что путь превращается в чужое относительное имя
 */
const REMOVAL_PROGRAM = 'rm';

/** Повышение прав: удаление «от администратора» область не покрывает, даже во временной папке */
const ELEVATORS: ReadonlySet<string> = new Set(['sudo', 'doas']);

/** Встроенные команды, что задают переменные своими аргументами */
const ASSIGNING_BUILTINS: ReadonlySet<string> = new Set(['export', 'declare', 'typeset', 'local', 'readonly']);

/** Команды, после которых переменным и каталогу верить нельзя: они меняют среду так, что разбор этого не видит */
const ENVIRONMENT_CHANGERS: ReadonlySet<string> = new Set(['eval', 'source', '.', 'read', 'mapfile', 'readarray', 'getopts', 'unset']);

/** Начало группы или оператора управления: что внутри, разбор этапами не видит; также `f() {` — определение функции */
const CONTROL_WORD = /^(?:[({!]|if$|then$|else$|elif$|do$|while$|until$|for$|case$|select$|function$)|\(\)$/;

/** `cd` и родственные где угодно в этапе: `(cd /etc && …)`, `builtin cd`, `eval "cd …"` */
const DIRECTORY_CHANGE = /(?:^|[\s;&|(){])(?:cd|pushd|popd|chdir)(?:\s|$)/;

/** Присвоение `NAME=значение`; `NAME+=значение` дописывает к прежнему, поэтому прежнему значению после него верить нельзя */
const ASSIGNMENT = /^([A-Za-z_][A-Za-z0-9_]*)(\+?)=(.*)$/s;

/** Символы шаблона имён: цель с ними — не один файл, а набор */
const GLOB_CHARS = /[*?[\]]/;

/** Параметры области: что считается проектом и откуда идёт командная строка */
export interface IShellRemovalScopeOptions {
	/** Папки проекта: удаление внутри них обратимо, потому что на ход снят чекпоинт */
	readonly roots: readonly string[];
	/** Каталог, в котором стоит командная строка; без него относительные пути не читаются */
	readonly cwd?: string;
}

/** Что разбор знает о среде к текущему месту строки */
interface IEnvironment {
	/** Значения переменных, уже раскрытые в пути; `undefined` — переменная была, но верить ей нельзя */
	variables: Map<string, string | undefined>;
	/** Каталог строки; `undefined` — неизвестен с начала */
	cwd: string | undefined;
	/** Каталог сменили на неизвестный или внешний: относительные пути больше не читаются, доверие не возвращается */
	directoryLost: boolean;
	/** Среду меняли непонятно как: даже `$TMPDIR` больше не временный каталог по определению */
	variablesLost: boolean;
}

/**
 * Область для `analyzeShellLine`: удаление внутри временных каталогов и проекта не считается разрушительным
 * Без папок проекта действуют только временные каталоги
 */
export function createShellRemovalScope(options: IShellRemovalScopeOptions): IShellLineScope {
	const roots = options.roots.map(root => normalizeAbsolute(slashed(root))).filter(root => root !== '/');
	const cwd = options.cwd ? normalizeAbsolute(slashed(options.cwd)) : undefined;
	return new RemovalScope(roots, { variables: new Map(), cwd, directoryLost: false, variablesLost: false });
}

class RemovalScope implements IShellLineScope {

	constructor(
		private readonly _roots: readonly string[],
		private readonly _env: IEnvironment,
	) { }

	fork(): IShellLineScope {
		return new RemovalScope(this._roots, { ...this._env, variables: new Map(this._env.variables) });
	}

	excuses(stage: readonly string[], verdict: ShellSafetyResult): boolean {
		if (programOf(verdict.command) !== REMOVAL_PROGRAM || !verdict.reasons.every(reason => REMOVAL_REASONS.has(reason))) {
			return false;
		}
		if (stage.some(word => ELEVATORS.has(programOf(word)))) {
			return false;
		}
		const targets = removalTargets(verdict.args);
		return targets !== undefined && targets.length > 0 && targets.every(target => this._isContained(target));
	}

	note(chain: readonly (readonly string[])[], stage: readonly string[]): void {
		let first = 0;
		while (first < stage.length && ASSIGNMENT.test(stage[first])) {
			first++;
		}
		// Этап конвейера идёт в своей оболочке: что он задал, после него не действует
		// Но недоверие переносится и оттуда: «ничего не изменилось» разрешает, «могло измениться» — нет
		const alone = chain.length === 1;
		const program = first < stage.length ? programOf(stage[first]) : '';
		if (first === stage.length) {
			if (alone) { stage.forEach(word => this._assign(word)); }
		} else if (ASSIGNING_BUILTINS.has(program)) {
			if (alone) { stage.slice(first + 1).filter(word => ASSIGNMENT.test(word)).forEach(word => this._assign(word)); }
		} else if (program === 'cd' || program === 'pushd') {
			if (alone) { this._changeDirectory(stage.slice(first + 1)); } else { this._env.directoryLost = true; }
		} else if (DIRECTORY_CHANGE.test(stage.join(' '))) {
			this._env.directoryLost = true;
			this._env.variablesLost = true;
			this._env.variables.clear();
		} else if (ENVIRONMENT_CHANGERS.has(program) || CONTROL_WORD.test(stage[first]) || (program === 'printf' && stage.includes('-v'))) {
			this._env.variablesLost = true;
			this._env.variables.clear();
		}
	}

	private _assign(word: string): void {
		const match = ASSIGNMENT.exec(word);
		if (!match) {
			return;
		}
		const [, name, append, raw] = match;
		// Второе присвоение той же переменной в одной строке не читается: оно могло пойти в фоне или в подоболочке
		const known = this._env.variables.has(name);
		this._env.variables.set(name, known || append ? undefined : this._valueOf(raw));
	}

	/** Значение присвоения как путь, или `undefined`, когда по нему нельзя судить о том, что будет удалено */
	private _valueOf(raw: string): string | undefined {
		const substitution = /^\$\((.*)\)$/s.exec(raw) ?? /^`(.*)`$/s.exec(raw);
		const value = substitution ? this._mktempPath(substitution[1]) : this._expand(raw);
		// Значение с пробелом или шаблоном при подстановке без кавычек распадётся на несколько целей
		return value === undefined || /\s/.test(value) || GLOB_CHARS.test(value) ? undefined : value;
	}

	/** Куда `mktemp` положит результат: путь с шаблоном, из которого видно, во временном ли он каталоге */
	private _mktempPath(command: string): string | undefined {
		const chains = parseShellLine(command);
		if (chains.length !== 1 || chains[0].length !== 1 || programOf(chains[0][0][0]) !== 'mktemp') {
			return undefined;
		}
		let directory: string | undefined;
		let template: string | undefined;
		let inTemp = false;
		const args = chains[0][0].slice(1);
		for (let i = 0; i < args.length; i++) {
			const arg = args[i];
			if (arg === '-p') {
				directory = args[++i];
				if (directory === undefined) { return undefined; }
			} else if (arg.startsWith('--tmpdir=')) {
				directory = arg.slice('--tmpdir='.length);
			} else if (arg === '--tmpdir' || arg === '-t') {
				inTemp = true;
			} else if (/^-[dqu]+$/.test(arg) || arg === '--directory' || arg === '--quiet' || arg === '--dry-run') {
				continue;
			} else if (arg.startsWith('-') || template !== undefined) {
				return undefined;
			} else {
				template = arg;
			}
		}
		const name = template === undefined ? 'tmp.XXXXXXXXXX' : this._expand(template);
		const base = directory !== undefined ? this._expand(directory) : inTemp || template === undefined ? TEMP_STAND_IN : '';
		if (name === undefined || base === undefined || (base !== '' && name.includes('/'))) {
			return undefined;
		}
		return this._resolve(base === '' ? name : `${base}/${name}`);
	}

	/** Подставляет известные переменные; `undefined`, если осталось то, чего разбор не раскроет */
	private _expand(text: string): string | undefined {
		let unknown = false;
		const expanded = text
			.replace(/\$(?:\{(\w+)\}|(\w+))/g, (match, braced: string | undefined, bare: string | undefined) => {
				const name = braced ?? bare ?? '';
				const value = this._env.variables.has(name)
					? this._env.variables.get(name)
					: TEMP_VARIABLES.has(name) && !this._env.variablesLost ? TEMP_STAND_IN : undefined;
				if (value === undefined) {
					unknown = true;
				}
				return value ?? match;
			});
		return unknown || /[$`(){}]/.test(expanded) || expanded.startsWith('~') ? undefined : expanded;
	}

	/** Абсолютный нормализованный путь слова, или `undefined`, если без догадок его не получить */
	private _resolve(word: string): string | undefined {
		const expanded = this._expand(word);
		if (!expanded) {
			return undefined;
		}
		const text = slashed(expanded);
		if (/^(?:[A-Za-z]:)?\//.test(text)) {
			return normalizeAbsolute(text);
		}
		// Относительный путь читается от каталога строки, и `..` из него не выводит: куда он ведёт, зависит от каталога
		if (this._env.directoryLost || this._env.cwd === undefined || text.split('/').includes('..')) {
			return undefined;
		}
		return normalizeAbsolute(`${this._env.cwd}/${text}`);
	}

	private _changeDirectory(args: readonly string[]): void {
		const operands = args.filter(arg => !arg.startsWith('-'));
		const path = operands.length === 1 ? this._resolve(operands[0]) : undefined;
		if (path !== undefined && this._within(path)) {
			this._env.cwd = path;
		} else {
			// Если `cd` не сработает, строка останется там, куда разбор уже не дойдёт, — поэтому доверие не возвращается
			this._env.directoryLost = true;
		}
	}

	/** Путь лежит в области или совпадает с её корнем: годится как каталог строки, но не как цель удаления */
	private _within(path: string): boolean {
		return [...this._roots, ...TEMP_ROOTS].some(root => path === root || path.startsWith(`${root}/`)) || WINDOWS_TEMP.test(`${path}/`);
	}

	/** Цель удаления лежит строго внутри области, не сам её корень и не набор «всё в корне» */
	private _isContained(target: string): boolean {
		const path = this._resolve(target);
		if (path === undefined || path.split('/').some(mayBeGit)) {
			return false;
		}
		const below = [...this._roots, ...TEMP_ROOTS]
			.map(root => path.startsWith(`${root}/`) ? path.slice(root.length + 1) : undefined)
			.concat(WINDOWS_TEMP.exec(`${path}/`)?.[1]);
		// Первый уровень под корнем должен называть что-то определённое: `/tmp/*` — это всё, что во временной папке есть
		return below.some(rest => rest !== undefined && /[^*?[\]/]/.test(rest.split('/')[0]));
	}
}

/**
 * Цели `rm`: всё, что не опция; после `--` опций нет
 * `undefined`, когда команда просит снять защиту от удаления корня
 */
function removalTargets(args: readonly string[]): string[] | undefined {
	const targets: string[] = [];
	let optionsEnded = false;
	for (const arg of args) {
		if (optionsEnded || !arg.startsWith('-') || arg === '-') {
			targets.push(arg);
		} else if (arg === '--') {
			optionsEnded = true;
		} else if (arg === '--no-preserve-root') {
			return undefined;
		}
	}
	return targets;
}

/** Сегмент пути, который может оказаться `.git`: само имя или шаблон, под который оно подходит (`.*`, `.g*`) */
function mayBeGit(segment: string): boolean {
	if (!GLOB_CHARS.test(segment)) {
		return segment === '.git';
	}
	const pattern = segment.replace(/[.+^${}()|\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.');
	try {
		return new RegExp(`^${pattern}$`).test('.git');
	} catch {
		// Шаблон не разобрался как выражение — значит, он необычный, и в сомнении это `.git`
		return true;
	}
}

function slashed(path: string): string {
	return path.replace(/\\/g, '/');
}

/**
 * Абсолютный путь без `.`, `..` и повторных слэшей; буква диска строчная — так её пишет `fsPath`
 * Путь Git Bash `/c/proj` приводится к `c:/proj`: на Windows это один и тот же каталог, а на других системах
 * корни проекта проходят через ту же замену, так что совпадение не появляется из ничего
 */
function normalizeAbsolute(path: string): string {
	const windows = /^([A-Za-z]):/.exec(path) ?? /^\/([A-Za-z])(?=\/|$)/.exec(path);
	const parts: string[] = [];
	for (const part of path.slice(windows?.[0].length ?? 0).split('/')) {
		if (part === '' || part === '.') {
			continue;
		}
		if (part === '..') {
			parts.pop();
		} else {
			parts.push(part);
		}
	}
	return `${windows ? `${windows[1].toLowerCase()}:` : ''}/${parts.join('/')}`;
}
