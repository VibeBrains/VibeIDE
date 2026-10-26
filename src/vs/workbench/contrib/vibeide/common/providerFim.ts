/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { providerVendor } from './modelCapabilities.js';
import type { ProviderVendor } from './providerVendor.js';

/** Встроенные провайдеры, у которых автодополнение (FIM) разрешено без явного объявления `fim` у модели. */
const FIM_BUILTIN_PROVIDERS: readonly string[] = ['ollama', 'openRouter', 'liteLLM'];

/** Вендоры из файлов набора с тем же правом: Mistral (Codestral) и «Совместимо с OpenAI API» (свой сервер, возможно локальный). */
const FIM_VENDORS: ReadonlySet<ProviderVendor> = new Set<ProviderVendor>(['mistral', 'openAICompatible']);

/**
 * Автодополнение разрешено провайдеру по умолчанию — не только модели с объявленным `supportsFIM`.
 * Mistral и «Совместимо с OpenAI API» больше не встроенные, поэтому узнаются по вендору (id в любом написании или родной адрес).
 * Официальный API OpenAI суффикса не принимает, vLLM и LM Studio — тоже.
 */
export const providerSupportsFIM = (providerName: string): boolean => {
	if (FIM_BUILTIN_PROVIDERS.includes(providerName)) { return true; }
	const vendor = providerVendor(providerName);
	return vendor !== undefined && FIM_VENDORS.has(vendor);
};
