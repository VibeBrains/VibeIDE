/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Rendering agent answers for Telegram. Pure functions — testable without a bot.
 *
 * Telegram's own "MarkdownV2" is a trap for our case: it demands that a dozen punctuation
 * characters be escaped everywhere, and a model's answer is full of them. One stray `*` in
 * generated code makes the API reject the whole message, so the answer would be lost rather
 * than merely ugly. We therefore convert the few markdown shapes that matter into Telegram's
 * HTML mode, where escaping is just three characters.
 */

/** Telegram rejects messages longer than this (4096 characters). */
export const TELEGRAM_MESSAGE_LIMIT = 4096;

/** Escapes the three characters that Telegram's HTML mode treats as markup. */
export function escapeTelegramHtml(text: string): string {
	return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/**
 * Converts a markdown answer to Telegram HTML: fenced code, inline code, bold, italic, links.
 *
 * Everything is escaped first and markup applied afterwards, so no content can inject tags.
 * Shapes we do not support are left as plain text — a visible asterisk is a smaller problem
 * than a rejected message.
 */
export function markdownToTelegramHtml(markdown: string): string {
	const fences: string[] = [];
	// Pull fenced blocks out first: their content must not be touched by the inline rules
	// below, or a `*` inside code would turn into bold and corrupt the snippet.
	const withoutFences = markdown.replace(/```[^\n]*\n?([\s\S]*?)```/g, (_all, body: string) => {
		fences.push(`<pre><code>${escapeTelegramHtml(body.replace(/\n$/, ''))}</code></pre>`);
		// Control-character delimiters: a Telegram message cannot contain them, so an answer
		// cannot forge a placeholder and get markup spliced back into it.
		return `\u0001${fences.length - 1}\u0001`;
	});

	let html = escapeTelegramHtml(withoutFences);
	html = html.replace(/`([^`\n]+)`/g, (_all, code: string) => `<code>${code}</code>`);
	html = html.replace(/\*\*([^*\n]+)\*\*/g, (_all, bold: string) => `<b>${bold}</b>`);
	html = html.replace(/(^|[\s(])_([^_\n]+)_(?=$|[\s).,!?])/g, (_all, lead: string, italic: string) => `${lead}<i>${italic}</i>`);
	html = html.replace(/\[([^\]\n]+)\]\((https?:\/\/[^\s)]+)\)/g, (_all, label: string, href: string) => `<a href="${href}">${label}</a>`);

	return html.replace(/\u0001(\d+)\u0001/g, (_all, index: string) => fences[Number(index)] ?? '');
}

/**
 * Splits a rendered message into Telegram-sized chunks.
 *
 * Splitting happens on line boundaries where possible: cutting mid-tag would produce invalid
 * HTML and Telegram would refuse the chunk. A single line longer than the limit is cut hard —
 * losing formatting there beats losing the message.
 */
export function splitForTelegram(text: string, limit: number = TELEGRAM_MESSAGE_LIMIT): string[] {
	if (text.length <= limit) {
		return [text];
	}
	const chunks: string[] = [];
	let current = '';
	for (const line of text.split('\n')) {
		if (line.length > limit) {
			if (current) {
				chunks.push(current);
				current = '';
			}
			for (let i = 0; i < line.length; i += limit) {
				chunks.push(line.slice(i, i + limit));
			}
			continue;
		}
		if (current.length + line.length + 1 > limit) {
			chunks.push(current);
			current = line;
		} else {
			current = current ? `${current}\n${line}` : line;
		}
	}
	if (current) {
		chunks.push(current);
	}
	return chunks;
}

/** Renders the one-line progress note that gets edited in place during a long run. */
export function formatProgressLine(elapsedMs: number, lastActivity: string | undefined): string {
	const seconds = Math.floor(elapsedMs / 1000);
	const time = seconds < 60 ? `${seconds} с` : `${Math.floor(seconds / 60)} мин ${seconds % 60} с`;
	const tail = lastActivity ? `: ${lastActivity}` : '';
	return `⏳ Работаю ${time}${tail}`;
}
