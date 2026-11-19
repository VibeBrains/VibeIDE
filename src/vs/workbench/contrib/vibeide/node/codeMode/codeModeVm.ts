/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Песочница скрипта Code Mode: `vm` внутри отдельного процесса
 *
 * Процесс без fs, сети и child_process сам по себе, но главное — контекст `vm` не получает
 * ни одного объекта хоста: только интринсики нового realm (JSON, Math, Date, Promise) и одну
 * функцию-мост для вызова инструментов. Мост живёт без прототипа, а генерация кода запрещена,
 * поэтому классический побег `constructor.constructor('return process')()` обрывается на выходе
 * из realm: у функции из песочницы нет пути к `Function` хоста
 */

import * as vm from 'vm';
import {
	CODE_MODE_MAX_ARGS_CHARS,
	CODE_MODE_MAX_CALL_NAME_CHARS,
	CODE_MODE_MAX_SCRIPT_CHARS,
	CODE_MODE_MAX_VALUE_CHARS,
	codeModeCallBudgetError,
	codeModeToolRefusal,
} from '../../common/codeMode/codeMode.js';
import { ICodeModeOutcome, codeModeErrorMessage } from '../../common/codeMode/codeModeIpc.js';

export interface ICodeModeVmToolAnswer {
	readonly ok: boolean;
	readonly text: string;
}

export interface ICodeModeVmOptions {
	readonly script: string;
	readonly timeoutMs: number;
	readonly maxCalls: number;
	/** Единственный канал наружу: окно решает, можно ли звать инструмент и каким путём */
	callTool(tool: string, argsJson: string): Promise<ICodeModeVmToolAnswer>;
}

interface ICodeModeSandboxApi {
	readonly logs: readonly unknown[];
	readonly done: Promise<unknown>;
}

/**
 * Тело обёртки: собирает `tools` и `console` изнутри realm и запускает скрипт пользователя
 *
 * `__bridge` приходит аргументом и удаляется из globalThis до первого шага пользовательского кода
 * Скрипт всё равно видит его по имени — поэтому мост безопасен сам по себе: функция хоста без прототипа,
 * ничего не возвращает и не бросает, а ответ отдаёт строкой в колбэк, созданный внутри realm
 * Promise хоста наружу не уходит: его `.constructor.constructor` — это `Function` хоста и полный Node
 */
function buildSandboxSource(script: string): string {
	return `(function (__bridge) {
	'use strict';
	var __logs = [];
	var __stringify = function (value) {
		try {
			var text = JSON.stringify(value);
			return text === undefined ? String(value) : text;
		} catch (e) {
			return String(value);
		}
	};
	var console = Object.freeze({
		log: function () {
			var parts = [];
			for (var i = 0; i < arguments.length; i++) {
				// Строка в console.log — это текст, а не JSON: кавычки и экранирование здесь лишние
				parts.push(typeof arguments[i] === 'string' ? arguments[i] : __stringify(arguments[i]));
			}
			__logs.push(parts.join(' '));
		}
	});
	var tools = new Proxy(Object.create(null), {
		get: function (target, prop) {
			if (typeof prop !== 'string' || prop === 'then') {
				return undefined;
			}
			return async function (args) {
				var payload = args === undefined ? '{}' : __stringify(args);
				var answer = JSON.parse(await new Promise(function (resolve) {
					__bridge(prop, payload, resolve);
				}));
				if (answer.ok === true) {
					return answer.text;
				}
				throw new Error(String(answer.text));
			};
		}
	});
	delete globalThis.__codeModeBridge;
	return {
		logs: __logs,
		done: (async function () {
${script}
		}).call(undefined)
	};
})(globalThis.__codeModeBridge)`;
}

function isTimeoutError(error: unknown): boolean {
	return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 'ERR_SCRIPT_EXECUTION_TIMEOUT';
}

function serializeValue(value: unknown): { valueText?: string; valueError?: string } {
	try {
		const text = JSON.stringify(value);
		if (text === undefined) {
			return {};
		}
		return { valueText: text.length <= CODE_MODE_MAX_VALUE_CHARS ? text : `${text.slice(0, CODE_MODE_MAX_VALUE_CHARS)}…` };
	} catch (error) {
		return { valueError: codeModeErrorMessage(error) };
	}
}

/**
 * Выполнить скрипт и дождаться его значения
 *
 * `timeoutMs` ограничивает синхронную часть через `vm`, а асинхронную — гонка с таймером:
 * после первого `await` vm уже не следит за кодом, и зависший цикл с `await` иначе не остановить
 * Полностью заблокированный event loop убивает главный процесс
 */
export async function runCodeModeScript(options: ICodeModeVmOptions): Promise<ICodeModeOutcome> {
	if (options.script.length > CODE_MODE_MAX_SCRIPT_CHARS) {
		return { logs: [], calls: [], error: `Скрипт длиннее ${CODE_MODE_MAX_SCRIPT_CHARS} символов` };
	}

	const records: Array<{ tool: string; ok: boolean; error?: string }> = [];
	let usedCalls = 0;

	const answerFor = async (name: unknown, argsJson: unknown): Promise<string> => {
		const tool = typeof name === 'string' ? name : '';
		const payload = typeof argsJson === 'string' ? argsJson : '{}';
		const refusal = codeModeToolRefusal(tool)
			?? (payload.length > CODE_MODE_MAX_ARGS_CHARS ? `Аргументы вызова «${tool}» длиннее ${CODE_MODE_MAX_ARGS_CHARS} символов` : undefined)
			?? codeModeCallBudgetError(usedCalls, options.maxCalls);
		if (refusal) {
			records.push({ tool: tool.slice(0, CODE_MODE_MAX_CALL_NAME_CHARS), ok: false, error: refusal });
			return JSON.stringify({ ok: false, text: refusal });
		}
		usedCalls++;
		try {
			const answer = await options.callTool(tool, payload);
			records.push({ tool, ok: answer.ok, ...(answer.ok ? {} : { error: answer.text }) });
			return JSON.stringify({ ok: answer.ok, text: answer.text });
		} catch (error) {
			const text = codeModeErrorMessage(error);
			records.push({ tool, ok: false, error: text });
			return JSON.stringify({ ok: false, text });
		}
	};
	// Мост отдаёт ответ только строкой в колбэк из песочницы: ни Promise хоста, ни ошибка хоста
	// не попадают в realm скрипта — через их `.constructor` достаётся Function хоста
	const bridge = function (name: unknown, argsJson: unknown, done: unknown): void {
		if (typeof done !== 'function') {
			return;
		}
		const deliver = (text: string) => {
			try {
				(done as (text: string) => void)(text);
			} catch {
				// Колбэк из песочницы бросил — это её дело, хосту отвечать нечего
			}
		};
		answerFor(name, argsJson).then(deliver, error => deliver(JSON.stringify({ ok: false, text: codeModeErrorMessage(error) })));
	};
	// Без прототипа у моста нет `.constructor` — иначе через него достаётся Function хоста
	Object.setPrototypeOf(bridge, null);

	const context = vm.createContext({}, {
		name: 'vibeide-code-mode',
		codeGeneration: { strings: false, wasm: false },
	});
	(context as { __codeModeBridge?: unknown }).__codeModeBridge = bridge;

	let api: ICodeModeSandboxApi;
	try {
		const source = new vm.Script(buildSandboxSource(options.script), { filename: 'code-mode-script.js' });
		api = source.runInContext(context, { timeout: options.timeoutMs }) as ICodeModeSandboxApi;
	} catch (error) {
		return {
			logs: [],
			calls: records,
			error: isTimeoutError(error)
				? `Превышено время выполнения скрипта (${Math.round(options.timeoutMs / 1000)} с)`
				: codeModeErrorMessage(error),
		};
	}

	const deadline = Date.now() + options.timeoutMs;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let value: unknown;
	try {
		const raced = await Promise.race([
			Promise.resolve(api.done).then(result => ({ kind: 'value' as const, result })),
			new Promise<{ kind: 'timeout' }>(resolve => {
				timer = setTimeout(() => resolve({ kind: 'timeout' }), Math.max(1, deadline - Date.now()));
			}),
		]);
		if (raced.kind === 'timeout') {
			return { logs: readLogs(api), calls: records, error: `Превышено время выполнения скрипта (${Math.round(options.timeoutMs / 1000)} с)` };
		}
		value = raced.result;
	} catch (error) {
		return { logs: readLogs(api), calls: records, error: codeModeErrorMessage(error) };
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}

	return { logs: readLogs(api), calls: records, ...serializeValue(value) };
}

/** Массив логов создан в песочнице: читаем только строки, остальное приводим к тексту */
function readLogs(api: ICodeModeSandboxApi): string[] {
	if (!Array.isArray(api.logs)) {
		return [];
	}
	// `Array.from` хоста создаёт массив хоста: `api.logs.map` вернул бы массив чужого realm,
	// и `deepStrictEqual` справедливо счёл бы его не равным обычному массиву
	return Array.from(api.logs, line => typeof line === 'string' ? line : String(line));
}
