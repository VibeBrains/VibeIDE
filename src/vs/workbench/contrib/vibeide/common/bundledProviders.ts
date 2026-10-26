/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Комплектные файлы провайдеров: слабейший слой каталога, который продукт держит у себя.
 *
 * Anthropic, OpenAI, Gemini, xAI, Mistral, Groq, Pollinations, Vertex, Azure и Bedrock перестали быть встроенными провайдерами
 * и подключаются файлами набора `.vibe/providers/*.jsonc`. Но файл набора появляется в проекте только когда проект засеян:
 * первый запуск без папки, окно без проекта и проект, засеянный до появления файла, остались бы без этих провайдеров — а с ними
 * без знакомства, где человек впервые вводит ключ. Поэтому копия этих файлов зашита в продукт (вместе с манифестом набора)
 * и стоит ПОД всеми слоями на диске: файл в `~/.vibe/providers/` или в проекте с тем же id перекрывает её поле за полем,
 * как обычно перекрывает слабый слой сильный.
 *
 * Только эти десять: остальные файлы набора (Kimi, Z.ai, Qwen…) по-прежнему появляются засевом, и удалить такой файл — значит
 * убрать провайдера. Комплектного провайдера удаляют так же, как любого каталожного: `{ "id": "groq", "active": false }`
 * в своём `providers.json`.
 */

import { vibeDefaultContent } from './vibeDefaults.js';
import { CONFIG_ID_OF_VENDOR, PROVIDER_VENDORS } from './providerVendor.js';
import { parseProvidersFile, VibeProviderEntry } from './vibeProvidersFile.js';

/**
 * Id комплектных провайдеров: файл набора называется так же (`providers/<id>.jsonc`).
 * «Совместимо с OpenAI API» в списке нет: для него в наборе образец `_template-openai-compatible.jsonc`, а не провайдер.
 */
export const BUNDLED_PROVIDER_IDS: readonly string[] = PROVIDER_VENDORS
	.filter(vendor => vendor !== 'openAICompatible')
	.map(vendor => CONFIG_ID_OF_VENDOR[vendor]);

/** Путь файла комплектного провайдера в манифесте набора. */
export const bundledProviderPath = (id: string): string => `providers/${id}.jsonc`;

let cached: readonly VibeProviderEntry[] | undefined;

/**
 * Записи комплектных провайдеров, по порядку списка, из манифеста набора. Битый или отсутствующий файл в манифесте даёт
 * пропуск, а не падение: остальные комплектные работают.
 */
export function bundledProviderLayer(): readonly VibeProviderEntry[] {
	if (cached) { return cached; }
	const entries: VibeProviderEntry[] = [];
	for (const id of BUNDLED_PROVIDER_IDS) {
		const raw = vibeDefaultContent(bundledProviderPath(id));
		if (raw === undefined) { continue; }
		const parsed = parseProvidersFile(raw);
		if (parsed.ok) { entries.push(...parsed.providers); }
	}
	cached = entries;
	return entries;
}
