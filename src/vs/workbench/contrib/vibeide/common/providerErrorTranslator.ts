/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Deterministic Russian translation of well-known provider error texts surfaced in the
 * chat error banner. Provider errors arrive as raw English strings (HTTP bodies, SDK
 * messages, aggregator proxies); translating them via an LLM is NOT an option on this
 * path — the model is exactly what just failed. A pattern dictionary covers the
 * high-frequency families; unmatched text passes through untranslated (returns null).
 *
 * Matched output keeps a truncated original in parentheses for searchability and bug
 * reports — users paste the English text into issue trackers / provider status pages.
 *
 * Pure and dependency-free → unit-testable from test/common/.
 */

import { isContextOverflow } from './sendLLMMessageTypes.js';

/** Max characters of the original error text echoed after the translation. */
const ORIGINAL_ECHO_MAX_CHARS = 180;

/** Ordered dictionary — FIRST match wins, so specific families go before generic ones. */
const TRANSLATION_RULES: readonly { pattern: RegExp; ru: string }[] = [
	// Usage-quota exhausted — MUST precede rate-limit: «Rate limit exceeded: Monthly usage
	// limit reached» (observed openCodeGo Go, retry-after ≈ 5 days) would otherwise match the
	// rate-limit family and tell the user to «подождите немного» — false advice for a
	// monthly quota.
	{
		pattern: /monthly usage limit|usage limit (?:reached|exceeded)|quota (?:exhausted|reached)|enable usage from your available balance|(?:Go|Free)UsageLimitError/i,
		ru: 'Исчерпан лимит использования модели у провайдера (квота за период). Ожидание не поможет — пополните баланс/квоту или переключитесь на другую модель/провайдера.',
	},
	// Ended free tier / promotion — observed openCodeGo 401 «Free promotion has ended for
	// Qwen3.6 Plus Free. You can continue using the model by subscribing…».
	{
		pattern: /free (?:promotion|tier|trial|period) has ended|continue using the model by subscribing|subscription required/i,
		ru: 'Бесплатный доступ к этой модели у провайдера закончился — требуется подписка. Переключите модель или оформите подписку у провайдера.',
	},
	// Billing / credits — before rate-limit ("quota" alone is ambiguous, billing wording is specific).
	{
		pattern: /insufficient[\s_-]*(?:credits?|balance|funds|quota)|payment required|billing|\b402\b|top up|exceeded your current quota/i,
		ru: 'Недостаточно средств или исчерпана квота у провайдера. Проверьте баланс аккаунта.',
	},
	// Rate limit.
	{
		pattern: /rate[\s_-]?limit|too many requests|\b429\b|requests? per (?:minute|second|day)/i,
		ru: 'Провайдер ограничил частоту запросов (rate limit). Подождите немного и повторите.',
	},
	// Overload / capacity.
	{
		pattern: /overloaded|over capacity|capacity|\b529\b|server is busy/i,
		ru: 'Провайдер перегружен. Попробуйте позже или переключите модель.',
	},
	// Auth — invalid key.
	{
		pattern: /unauthorized|invalid (?:api[\s_-]?key|x-api-key|token|credentials)|authentication|incorrect api key|\b401\b/i,
		ru: 'Ошибка авторизации у провайдера: проверьте API-ключ в настройках.',
	},
	// Auth — forbidden.
	{
		pattern: /forbidden|permission denied|access denied|\b403\b/i,
		ru: 'Провайдер отклонил доступ (403). Проверьте права ключа и подписку.',
	},
	// Tool-calling unsupported by the routed endpoint (OpenRouter free variants often lack
	// tools) — observed: 404 «No endpoints found that support the provided 'tool_choice'».
	{
		pattern: /no endpoints found that support.{0,40}tool|does not support tool(?:s| use| calling)|tool_choice.{0,40}not supported/i,
		ru: 'Выбранный вариант модели не поддерживает вызов инструментов (у free-эндпоинтов OpenRouter tools часто отключены). Переключите модель или выберите платный вариант той же модели.',
	},
	// Model not found.
	{
		pattern: /model.{0,40}(?:not found|does not exist|unknown|unavailable|decommissioned|deprecated)|no such model/i,
		ru: 'Модель не найдена или недоступна у провайдера. Проверьте имя модели в настройках.',
	},
	// Gateway / availability 5xx.
	{
		pattern: /bad gateway|service unavailable|internal server error|gateway time?-?out|\b50[0234]\b|\b52[0-9]\b/i,
		ru: 'Сервер провайдера временно недоступен (5xx). Повторите попытку позже.',
	},
	// Stream stall (provider-side wording; our own watchdog texts are Russian at source).
	{
		pattern: /stream (?:stalled|closed|ended unexpectedly|aborted)|no tokens received|connection (?:closed|reset|terminated) (?:before|while)/i,
		ru: 'Стрим оборвался: провайдер перестал присылать токены. Повторите попытку или переключите модель.',
	},
	// Timeout.
	{
		pattern: /request timed out|timed?[\s_-]?out|deadline exceeded|\b408\b/i,
		ru: 'Превышено время ожидания ответа провайдера. Повторите попытку.',
	},
	// Network reachability.
	{
		pattern: /ECONNREFUSED|ENOTFOUND|EAI_AGAIN|ECONNRESET|ETIMEDOUT|fetch failed|network error|unreachable|socket hang ?up|getaddrinfo/i,
		ru: 'Сетевая ошибка: провайдер недоступен. Проверьте интернет-соединение (и VPN/прокси, если используются).',
	},
];

/**
 * Translate a well-known raw provider error text to Russian. Returns null when the text
 * is empty, already contains Cyrillic (our localized messages pass through untouched),
 * or matches no known family — callers keep the original in those cases.
 */
export const translateProviderError = (message: string | null | undefined): string | null => {
	if (!message || !message.trim()) { return null; }
	// Already (at least partially) Russian — ours or pre-translated. Leave alone.
	if (/[а-яё]/i.test(message)) { return null; }

	let ru: string | undefined;
	if (isContextOverflow(message)) {
		// Context overflow has its own upstream classifier (parseContextOverflowError) for OUR
		// template; this branch catches RAW provider wording that bypassed it.
		ru = 'Запрос превысил контекстное окно модели. Сожмите историю чата (Compact) или переключите модель.';
	} else {
		ru = TRANSLATION_RULES.find(r => r.pattern.test(message))?.ru;
	}
	if (!ru) { return null; }

	const original = message.length > ORIGINAL_ECHO_MAX_CHARS
		? message.slice(0, ORIGINAL_ECHO_MAX_CHARS) + '…'
		: message;
	return `${ru}\n(исходно: «${original}»)`;
};
