/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Параметры провайдера из файла (`params`): значения, которые человек вводит в карточке, а файл подставляет
 * в адрес, заголовки и параметры запроса.
 *
 * Зачем: Vertex AI не живёт без региона и проекта, Azure — без имени ресурса, шлюз Bedrock — без адреса шлюза.
 * Засеянный файл набора общий для всех проектов и своих значений нести не может, а правка JSONC руками — не то,
 * что человек делал в карточке встроенного провайдера.
 *
 * Чистый разбор без сервисов: значения приходят параметром, результат — провайдер с подставленными значениями,
 * описание полей карточки и список параметров, без которых провайдер ещё не настроен.
 */

import type { VibeProviderEntry, VibeProviderParam } from './vibeProvidersFile.js';

/** Имя параметра: то, что можно написать в фигурных скобках адреса. */
const PARAM_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;

/** Одно поле карточки провайдера, объявленное файлом. */
export interface ProviderParamField {
	readonly name: string;
	readonly title: string;
	/** Подсказка для пустого поля: умолчание файла, а без него — `placeholder` файла. */
	readonly placeholder: string;
	/** Что человек ввёл; пусто, если ещё ничего (умолчание сюда не подставляется — оно видно подсказкой). */
	readonly value: string;
	readonly optional: boolean;
	/** `headers` — поле принимает JSON-объект заголовков, остальные — обычный текст. */
	readonly kind: 'text' | 'headers';
}

export interface AppliedProviderParams {
	/** Провайдер с подставленными значениями; без `params` приходит тем же объектом. */
	readonly entry: VibeProviderEntry;
	readonly fields: readonly ProviderParamField[];
	/** Обязательные параметры без значения и без умолчания: пока они пусты, запросы идти не могут. */
	readonly missing: readonly string[];
	readonly warnings: readonly string[];
}

const NO_FIELDS: readonly ProviderParamField[] = [];

function isDeclared(raw: unknown): raw is Record<string, VibeProviderParam> {
	return !!raw && typeof raw === 'object' && !Array.isArray(raw);
}

/** Значение параметра: введённое человеком, иначе умолчание файла, иначе ничего. */
function valueOf(param: VibeProviderParam, typed: string | undefined): string | undefined {
	const own = typed?.trim();
	if (own) { return own; }
	const fallback = typeof param.default === 'string' ? param.default.trim() : '';
	return fallback || undefined;
}

/** `{имя}` заменяется на значение только для объявленных параметров: чужие фигурные скобки остаются как есть. */
function substitute(text: string, resolved: ReadonlyMap<string, string>): string {
	return text.replace(/\{([A-Za-z][A-Za-z0-9_]*)\}/g, (whole, name: string) => resolved.has(name) ? resolved.get(name)! : whole);
}

function substituteRecord(record: Readonly<Record<string, string>> | undefined, resolved: ReadonlyMap<string, string>): Record<string, string> | undefined {
	if (!record) { return undefined; }
	const out: Record<string, string> = {};
	for (const [name, value] of Object.entries(record)) {
		const next = typeof value === 'string' ? substitute(value, resolved) : value;
		// Заголовок или параметр запроса, чьё значение целиком держалось на пустом необязательном параметре, не уходит
		if (next === '' && value !== '') { continue; }
		out[name] = next;
	}
	return out;
}

/** JSON-объект заголовков из поля `as: "headers"`; нечитаемое значение называется предупреждением и пропускается. */
function parseHeadersParam(providerId: string, name: string, raw: string, warnings: string[]): Record<string, string> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		warnings.push(`«${providerId}»: параметр «${name}» — не JSON, заголовки из него не добавлены`);
		return {};
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		warnings.push(`«${providerId}»: параметр «${name}» — не JSON-объект заголовков, они не добавлены`);
		return {};
	}
	const out: Record<string, string> = {};
	for (const [header, value] of Object.entries(parsed as Record<string, unknown>)) {
		if (typeof value === 'string') {
			out[header] = value;
		} else {
			warnings.push(`«${providerId}»: параметр «${name}» — значение заголовка «${header}» не строка, заголовок пропущен`);
		}
	}
	return out;
}

/**
 * Подставляет значения параметров в провайдера.
 *
 * @param entry провайдер как его написал файл, слои уже слиты
 * @param values что человек ввёл в карточке: имя параметра → текст
 */
export function applyProviderParams(entry: VibeProviderEntry, values: Readonly<Record<string, string>> | undefined): AppliedProviderParams {
	const declared = entry.params;
	if (declared === undefined) {
		return { entry, fields: NO_FIELDS, missing: [], warnings: [] };
	}
	const warnings: string[] = [];
	if (!isDeclared(declared)) {
		warnings.push(`«${entry.id}»: params — не объект, параметры из файла не читаются`);
		return { entry, fields: NO_FIELDS, missing: [], warnings };
	}

	const resolved = new Map<string, string>();
	const headerParams: { readonly name: string; readonly raw: string }[] = [];
	const fields: ProviderParamField[] = [];
	const missing: string[] = [];

	for (const [name, param] of Object.entries(declared)) {
		if (!PARAM_NAME.test(name) || !param || typeof param !== 'object') {
			warnings.push(`«${entry.id}»: параметр «${name}» пропущен — имя из латиницы, цифр и «_», описание — объект`);
			continue;
		}
		const kind = param.as === 'headers' ? 'headers' : 'text';
		if (param.as !== undefined && param.as !== 'headers') {
			warnings.push(`«${entry.id}»: у параметра «${name}» as ${JSON.stringify(param.as)} не разобран — допустимо "headers"; поле читается как текст`);
		}
		// Поле заголовков необязательно по природе: без него провайдер просто идёт без лишних заголовков
		const optional = param.optional === true || kind === 'headers';
		const typed = values?.[name];
		const value = valueOf(param, typed);
		if (value !== undefined) {
			if (kind === 'headers') {
				headerParams.push({ name, raw: value });
			} else {
				resolved.set(name, value);
			}
		} else if (optional) {
			if (kind === 'text') { resolved.set(name, ''); }
		} else {
			missing.push(name);
		}
		const fallback = typeof param.default === 'string' ? param.default.trim() : '';
		fields.push({
			name,
			title: param.title || name,
			placeholder: fallback || param.placeholder || '',
			value: typed?.trim() ? typed : '',
			optional,
			kind,
		});
	}

	const fetchSpec = entry.models?.fetch;
	const headers = substituteRecord(entry.headers, resolved);
	const mergedHeaders = headerParams.length > 0
		? Object.assign({}, headers ?? {}, ...headerParams.map(p => parseHeadersParam(entry.id, p.name, p.raw, warnings)))
		: headers;
	const query = substituteRecord(entry.query, resolved);

	const applied: VibeProviderEntry = {
		...entry,
		...(typeof entry.baseURL === 'string' ? { baseURL: substitute(entry.baseURL, resolved) } : {}),
		...(mergedHeaders ? { headers: mergedHeaders } : {}),
		...(query ? { query } : {}),
		...(entry.models && typeof fetchSpec === 'string' ? { models: { ...entry.models, fetch: substitute(fetchSpec, resolved) } } : {}),
	};

	return { entry: applied, fields, missing, warnings };
}
