/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Structured extraction: a web page's HTML and a JSON Schema in, JSON matching the schema out.
 *
 * WHY a dedicated tool and not the chat model: an extraction model such as inference.net's
 * Schematron does not take instructions at all — «This model does not use user/system prompts. It
 * only uses the schema to extract the data» (docs.inference.net, 13.09.2026). The chat path cannot
 * send that: it always carries a system prompt, and for a model without a system role it glues the
 * prompt into the user message, i.e. straight into the HTML. So the call goes out as ONE user
 * message holding the page, with the schema in `response_format` and temperature 0, as the vendor
 * examples do.
 *
 * Pure: HTML, schema and the model's text in; request fields and parsed data out.
 */

/** Characters of cleaned HTML sent to the model. ~128K-token context, and the answer needs room. */
export const EXTRACTION_MAX_HTML_CHARS = 300_000;

/** The HTML worth sending: scripts, styles, comments and head noise removed, whitespace folded. */
export function cleanHtmlForExtraction(html: string, maxChars = EXTRACTION_MAX_HTML_CHARS): { readonly html: string; readonly truncated: boolean } {
	const cleaned = html
		.replace(/<!--[\s\S]*?-->/g, '')
		.replace(/<(script|style|noscript|svg|iframe|template)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, '')
		.replace(/<(link|meta)\b[^>]*>/gi, '')
		.replace(/\s+/g, ' ')
		.trim();
	return cleaned.length > maxChars
		? { html: cleaned.slice(0, maxChars), truncated: true }
		: { html: cleaned, truncated: false };
}

/** Request fields for one extraction: the schema as `response_format`, deterministic sampling. */
export function extractionRequestBody(schema: Record<string, unknown>): Record<string, unknown> {
	return {
		response_format: {
			type: 'json_schema',
			json_schema: { name: 'extraction', schema, strict: true },
		},
		temperature: 0,
	};
}

/** The model's answer as data, or the reason it is not. A fenced block is tolerated, prose is not. */
export function parseExtractionAnswer(text: string): { readonly ok: true; readonly data: unknown } | { readonly ok: false; readonly reason: string } {
	const trimmed = text.trim();
	if (!trimmed) {
		return { ok: false, reason: 'модель вернула пустой ответ' };
	}
	const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(trimmed);
	try {
		return { ok: true, data: JSON.parse(fenced ? fenced[1] : trimmed) };
	} catch {
		return { ok: false, reason: 'ответ модели — не JSON' };
	}
}

/** A schema the tool accepts: a JSON object that declares a type or properties. */
export function isUsableSchema(value: unknown): value is Record<string, unknown> {
	return !!value && typeof value === 'object' && !Array.isArray(value)
		&& ('type' in value || 'properties' in value);
}
