/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure chat → Markdown serializer (no browser/node deps → unit-testable from test/common).
 *
 * Drives the chat "Copy to Markdown" / "Export .md" toolbar buttons. The key property: it
 * serializes EVERYTHING in the thread regardless of UI fold-state — reasoning blocks that are
 * collapsed in the sidebar (and therefore missed by text-selection) are emitted here in a
 * <details> block, so the user gets the full thinking trace without expanding each one by hand.
 *
 * Tool results are large; the caller chooses: `truncateToolResults: true` (Copy — keep the .md
 * small) or full (Export — exact log).
 */

import { ChatMessage } from './chatThreadServiceTypes.js';

export interface ThreadToMarkdownOptions {
	/** When true, each tool result is head+tail trimmed to `toolResultMaxChars`. Default false (full). */
	truncateToolResults?: boolean;
	/** Char budget per tool result when truncating. Default 2000. */
	toolResultMaxChars?: number;
	/** Optional H1 title. */
	title?: string;
	/** Optional metadata line (e.g. "minimax-m2.7 · openCodeGo · 2026-06-04"). */
	subtitle?: string;
}

const DEFAULT_TOOL_TRUNCATE_CHARS = 2000;

/** Head+tail trim with an explicit elision marker so the model/reader sees both ends. */
function headTail(s: string, max: number): string {
	if (s.length <= max) { return s; }
	const head = Math.ceil(max * 0.6);
	const tail = max - head;
	return `${s.slice(0, head)}\n… [усечено ${s.length - max} симв.] …\n${s.slice(s.length - tail)}`;
}

function fence(body: string, lang = ''): string[] {
	// Avoid premature fence close when the body itself contains ``` — bump to a longer fence.
	const ticks = body.includes('```') ? '````' : '```';
	return [`${ticks}${lang}`, body, ticks];
}

function stringifyResult(result: unknown): string {
	if (result === null || result === undefined) { return ''; }
	if (typeof result === 'string') { return result; }
	try { return JSON.stringify(result, null, 2); }
	catch { return String(result); }
}

export function threadToMarkdown(messages: readonly ChatMessage[], opts: ThreadToMarkdownOptions = {}): string {
	const truncate = opts.truncateToolResults ?? false;
	const maxChars = opts.toolResultMaxChars ?? DEFAULT_TOOL_TRUNCATE_CHARS;
	const out: string[] = [];

	out.push(`# ${opts.title ?? 'VibeIDE — экспорт чата'}`);
	if (opts.subtitle) { out.push('', `_${opts.subtitle}_`); }
	out.push('');

	for (const m of messages) {
		switch (m.role) {
			case 'user': {
				out.push('## 👤 Пользователь', '');
				out.push((m.displayContent || m.content || '').trim() || '_(пусто)_', '');
				break;
			}
			case 'assistant': {
				out.push('## 🤖 Ассистент', '');
				const reasoning = (m.reasoning || '').trim();
				if (reasoning) {
					out.push('<details><summary>🧠 Размышления</summary>', '');
					out.push(...fence(reasoning));
					out.push('', '</details>', '');
				}
				out.push((m.displayContent || '').trim() || '_(пусто)_', '');
				break;
			}
			case 'tool': {
				const mcp = m.mcpServerName ? ` (MCP: ${m.mcpServerName})` : '';
				out.push(`### 🔧 ${m.name}${mcp} — ${m.type}`, '');
				if (m.rawParams && Object.keys(m.rawParams).length) {
					out.push('**Параметры:**', ...fence(JSON.stringify(m.rawParams, null, 2), 'json'), '');
				}
				const resultStr = stringifyResult((m as { result?: unknown }).result);
				if (resultStr) {
					const body = truncate ? headTail(resultStr, maxChars) : resultStr;
					out.push('**Результат:**', ...fence(body), '');
				}
				break;
			}
			case 'interrupted_streaming_tool': {
				out.push(`### ⏹️ Прерван tool: ${m.name}`, '');
				break;
			}
			case 'checkpoint': {
				out.push(`> 📍 Чекпоинт (${m.type})`, '');
				break;
			}
			case 'plan': {
				out.push('## 🗂️ План', '', (m.summary || '').trim() || '_(без описания)_', '');
				for (const s of m.steps || []) {
					out.push(`- [${s.status ?? 'queued'}] ${s.stepNumber}. ${s.description}`);
				}
				out.push('');
				break;
			}
			case 'review': {
				out.push('## ✅ Ревью', '', (m.summary || '').trim() || '_(без описания)_', '');
				for (const issue of m.issues || []) {
					out.push(`- **${issue.severity}**: ${issue.message}${issue.file ? ` (${issue.file})` : ''}`);
				}
				out.push('');
				break;
			}
		}
	}

	// Collapse 3+ blank lines to a single blank, trim, end with one newline.
	return out.join('\n').replace(/\n{3,}/g, '\n\n').trim() + '\n';
}
