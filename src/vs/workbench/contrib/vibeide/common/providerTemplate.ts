/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Файл своего провайдера из образца набора (`providers/_template-openai-compatible.jsonc`).
 *
 * Кнопка «Добавить провайдера» копирует образец под именем человека и открывает копию: id, имя, переменная ключа и тумблер
 * подставляются здесь, остальное — адрес, ключ, модели — человек дописывает сам. Чистый разбор текста без файловой системы:
 * имя файла, id и текст приходят результатом, а записью и открытием занимается вызывающий.
 */

/** Путь образца в манифесте набора. */
export const PROVIDER_TEMPLATE_PATH = 'providers/_template-openai-compatible.jsonc';

/** Вымышленные значения образца, которые подставляются: id, имя и переменная ключа. */
const TEMPLATE_ID = 'my-provider';
const TEMPLATE_NAME = 'Мой провайдер';
const TEMPLATE_KEY_ENV = 'MY_PROVIDER_API_KEY';

export interface ProviderFromTemplate {
	/** Id нового провайдера — слаг из имени, по нему же называется файл. */
	readonly id: string;
	readonly fileName: string;
	readonly text: string;
}

export type ProviderFromTemplateResult =
	| { readonly ok: true; readonly provider: ProviderFromTemplate }
	| { readonly ok: false; readonly reason: 'empty-name' | 'template-unreadable' };

/** Id из имени: строчные латиница и цифры, остальное — дефисами. Пустой результат — имени не из чего собрать id. */
export function providerIdFromName(name: string): string {
	return name
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, '-')
		.replace(/^[-._]+|[-._]+$/g, '')
		.replace(/-{2,}/g, '-');
}

/** Имя переменной окружения для ключа: `my-proxy` → `MY_PROXY_API_KEY`. */
export function keyEnvNameOf(id: string): string {
	return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`;
}

/**
 * Копия образца под именем человека.
 * Образец выключен (`"active": false`) и описан как образец — в копии он включён, а шапка рассказывает, что делать дальше.
 */
export function providerFromTemplate(template: string | undefined, displayName: string): ProviderFromTemplateResult {
	const name = displayName.trim();
	const id = providerIdFromName(name);
	if (!name || !id) {
		return { ok: false, reason: 'empty-name' };
	}
	if (!template || !template.includes(`"id": "${TEMPLATE_ID}"`)) {
		return { ok: false, reason: 'template-unreadable' };
	}
	// Тело файла начинается со строки, где одна открывающая скобка; всё до неё — комментарий образца
	const rootAt = template.search(/^\{\s*$/m);
	if (rootAt < 0) {
		return { ok: false, reason: 'template-unreadable' };
	}
	const body = template.slice(rootAt);
	const header = [
		`// ${name} — свой провайдер, созданный из образца набора.`,
		'// Впишите baseURL (с версией пути: …/v1), при нужде auth и список моделей; ключ вводится в карточке провайдера',
		`// (Настройки → Облачные провайдеры → Свои провайдеры) или строкой ${keyEnvNameOf(id)}=<ключ> в .vibe/.env.`,
		'// Полная спека формата — docs/manuals/providersSpec.md: её можно целиком отдать своей LLM.',
		'',
	].join('\n');
	const text = header + body
		.replace(`"id": "${TEMPLATE_ID}"`, `"id": ${JSON.stringify(id)}`)
		.replace(`"name": "${TEMPLATE_NAME}"`, `"name": ${JSON.stringify(name)}`)
		.replace(/"active": false,[^\n]*/, '"active": true, // включён: пока не вписан baseURL и ключ, моделей в списках нет')
		.split(TEMPLATE_KEY_ENV).join(keyEnvNameOf(id));
	return { ok: true, provider: { id, fileName: `${id}.jsonc`, text } };
}
