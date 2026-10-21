/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Мост превью: что страница в рамке вправе сказать хрому и в каком виде это принимается.
 *
 * Страница в рамке — недоверенная сторона: превью открывает dev-сервер проекта, а проект может быть
 * чужим клоном. Скрипт моста в страницу вставляем мы сами, но там он такой же код, как любой другой
 * скрипт страницы: её автор может слать в хром те же сообщения напрямую.
 *
 * Правила приёма живут здесь, чистыми функциями, чтобы их можно было проверить без окна и без веб-вью.
 * Хром (`previewChromeHtml.ts`) отсекает чужой источник сообщений, хост (`vibeBrowserManager.ts`)
 * проверяет и обрезает то, что дошло.
 */

/**
 * Потолки полей, которые страница присылает хрому.
 * Скрипт моста сам режет вырезку разметки на 600 знаков; потолок хоста вдвое выше, чтобы не спорить с честной страницей.
 */
export const PREVIEW_BRIDGE_MAX = {
	href: 2048,
	path: 1024,
	selector: 512,
	html: 1200,
	title: 300,
	consoleText: 4000,
	rule: 80,
} as const;

/**
 * Права рамки с превью: ровно то, что веб-вью и так оставляет вложенной рамке.
 * Рамка наследует флаги песочницы веб-вью (скрипты, формы, загрузки, same-origin, pointer-lock), поэтому явный список
 * поведения не меняет, но закрепляет границу: без `allow-top-navigation`, `allow-popups` и `allow-modals` страница
 * не уведёт хром на другой адрес, не откроет окно и не повесит диалог, даже если веб-вью когда-нибудь станет щедрее.
 */
export const PREVIEW_FRAME_SANDBOX = 'allow-scripts allow-same-origin allow-forms allow-downloads allow-pointer-lock';

/** Схемы, которые превью показывает в рамке и открывает во внешнем браузере. Остальное — отказ. */
const WEB_PROTOCOLS: ReadonlySet<string> = new Set(['http:', 'https:']);

/**
 * Адрес в нормальной форме, если это `http`/`https`, иначе `undefined`.
 *
 * `file:`, `vscode:`, `data:`, `javascript:` и любые чужие схемы отсекаются: при `openExternal` платформа открывает их
 * системным обработчиком без вопросов, а проверка доверенных доменов касается только `http(s)`.
 * Адрес с именем и паролем перед хостом тоже отказ: `https://банк@чужой-хост/` — привычный приём подмены.
 */
export function webUrlOf(value: unknown): string | undefined {
	if (typeof value !== 'string' || value.length === 0 || value.length > PREVIEW_BRIDGE_MAX.href) {
		return undefined;
	}
	let url: URL;
	try {
		url = new URL(value.trim());
	} catch {
		return undefined;
	}
	if (!WEB_PROTOCOLS.has(url.protocol) || url.username !== '' || url.password !== '') {
		return undefined;
	}
	return url.href;
}

/**
 * Строка от страницы, обрезанная до `max`. Не строка — пустая.
 * `singleLine` схлопывает переводы строк: поле вроде селектора не должно добавлять строки в текст, который уйдёт в чат.
 */
export function clampBridgeText(value: unknown, max: number, singleLine = false): string {
	if (typeof value !== 'string') {
		return '';
	}
	const text = singleLine ? value.replace(/\s+/g, ' ').trim() : value;
	if (text.length <= max) {
		return text;
	}
	// Не оставлять половину суррогатной пары: она ломает вывод и JSON
	const cut = text.charCodeAt(max - 1);
	return text.slice(0, cut >= 0xD800 && cut <= 0xDBFF ? max - 1 : max);
}

export type PreviewConsoleLevel = 'log' | 'info' | 'warn' | 'error';

/** Уровень записи консоли страницы; незнакомое — `log`, а не строка страницы в журнале как есть. */
export function consoleLevelOf(value: unknown): PreviewConsoleLevel {
	return value === 'info' || value === 'warn' || value === 'error' ? value : 'log';
}

/**
 * Ограничитель частоты: страница, засыпающая хром сообщениями, не должна ни раздувать журнал, ни открывать вкладки пачкой.
 * Окно скользящее, время передаётся параметром — часы не читаются, функция остаётся чистой.
 */
export class BridgeRateLimiter {

	private _windowStart = 0;
	private _count = 0;

	constructor(private readonly _maxPerWindow: number, private readonly _windowMs: number) { }

	/** Можно ли принять ещё одно сообщение в момент `now` (мс). Принятое засчитывается. */
	allow(now: number): boolean {
		if (now - this._windowStart >= this._windowMs) {
			this._windowStart = now;
			this._count = 0;
		}
		if (this._count >= this._maxPerWindow) {
			return false;
		}
		this._count++;
		return true;
	}
}

/**
 * Сколько сообщений от страницы хром принимает.
 * Консоль честной страницы выдаёт десятки строк в секунду при перерисовке; сотни — уже затопление.
 * Открытие внешнего браузера по ссылке — действие человека: три за десять секунд с запасом, а пачка вкладок — это не он.
 */
export const PREVIEW_BRIDGE_RATE = {
	console: { max: 200, windowMs: 1000 },
	external: { max: 3, windowMs: 10_000 },
} as const;
