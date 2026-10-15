/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The editor's own MCP server for an external agent: what is open now and what the editor underlines
 *
 * The agent is a separate process and does not see the editor. The hint that rides in the prompt (`acpPromptContext`)
 * says what was open when the message was written; a tool answers for the moment the agent asks, in the middle of a
 * long turn, when the person has already moved to another file
 * The tools carry the names of the same two in VibeIDEA, so an agent that works with both finds the same vocabulary
 *
 * This module is the protocol and the wording: JSON-RPC over HTTP in the shape MCP clients speak (the handshake
 * revisions, `tools/list`, `tools/call`) and the text of the answers. Sockets and the editor are not here, so it is
 * checked from `test/common/`: the caller passes in a function that answers a tool call
 */

import { JsonValue } from './acpProtocol.js';

/** The name the agent sees the server under: its tools arrive prefixed with it */
export const IDE_MCP_SERVER_NAME = 'vibe-ide';

export const IDE_TOOL_OPEN_FILE = 'vibe_open_file';
export const IDE_TOOL_PROBLEMS = 'vibe_problems';

/**
 * Revisions of the protocol we answer to, newest first
 * The tools part of the handshake is the same in all of them; a client asking for one we do not know is told ours
 */
export const IDE_MCP_PROTOCOL_VERSIONS: readonly string[] = ['2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];

/** The largest request body: a tool call is a name and a couple of short arguments */
export const IDE_MCP_MAX_BODY_BYTES = 64 * 1024;

/** Open tabs named in an answer: more tells the agent nothing the first fifty do not */
export const IDE_MCP_MAX_TABS = 50;

/** Problems named in an answer: a file with more has a broken parse, and the first two hundred show where */
export const IDE_MCP_MAX_PROBLEMS = 200;

/** How long of a line the problem quotes */
const PROBLEM_LINE_CHARS = 200;

export interface IIdeMcpTool {
	readonly name: string;
	readonly title: string;
	readonly description: string;
	readonly inputSchema: JsonValue;
}

/** The tools in a fixed order: a client caches the listing, and a shuffle that changes nothing would break its cache */
export const IDE_MCP_TOOLS: readonly IIdeMcpTool[] = [
	{
		name: IDE_TOOL_OPEN_FILE,
		title: 'Что открыто в редакторе',
		description: 'Файл, открытый в редакторе IDE прямо сейчас: путь, выделенный человеком кусок и текст файла. ' +
			'Это ответ на «посмотри открытый файл»: без него такая просьба неисполнима, и остаётся просить у человека путь, ' +
			'который он уже назвал тем, что файл открыл. Возвращает и остальные открытые вкладки: над чем человек работает, ' +
			'видно по ним, а не по одному файлу. Текст берётся из редактора, а не с диска, поэтому несохранённые правки видны.',
		inputSchema: { type: 'object', properties: {} },
	},
	{
		name: IDE_TOOL_PROBLEMS,
		title: 'Ошибки и предупреждения файла',
		description: 'Что IDE подчеркнула в файле: ошибки и предупреждения с номером строки, важностью и сообщением. ' +
			'Это та же разметка, что на экране у человека, а не новый прогон проверок. Без аргумента берётся открытый в редакторе файл. ' +
			'Разметка есть только у открытого файла: для закрытого ответ «откройте его», а не пустой список. ' +
			'Пустой список значит «языковой сервер ничего не нашёл», а если файл только что менялся, он мог ещё не дочитать — спросите снова.',
		inputSchema: {
			type: 'object',
			properties: { path: { type: 'string', description: 'Путь файла; без него — открытый в редакторе' } },
		},
	},
];

/** What a tool answers: text for the agent, and whether the call failed */
export interface IIdeMcpToolResult {
	readonly text: string;
	readonly isError?: boolean;
}

/** Asks the editor to answer one tool call */
export type IdeMcpToolCaller = (tool: string, args: Record<string, JsonValue>) => Promise<IIdeMcpToolResult>;

/** The HTTP answer: the status, and the JSON-RPC body when there is one (a notification gets none) */
export interface IIdeMcpReply {
	readonly status: number;
	readonly body?: JsonValue;
}

const JSON_RPC_ERROR_PARSE = -32700;
const JSON_RPC_ERROR_INVALID_REQUEST = -32600;
const JSON_RPC_ERROR_METHOD_NOT_FOUND = -32601;
const JSON_RPC_ERROR_INVALID_PARAMS = -32602;
const JSON_RPC_ERROR_INTERNAL = -32603;

const errorReply = (id: JsonValue, code: number, message: string): IIdeMcpReply =>
	({ status: 200, body: { jsonrpc: '2.0', id, error: { code, message } } });

const resultReply = (id: JsonValue, result: JsonValue): IIdeMcpReply =>
	({ status: 200, body: { jsonrpc: '2.0', id, result } });

/** Answers one HTTP body: the handshake, the listing and the calls */
export async function handleIdeMcpBody(body: string, call: IdeMcpToolCaller): Promise<IIdeMcpReply> {
	let message: unknown;
	try {
		message = JSON.parse(body);
	} catch {
		return errorReply(null, JSON_RPC_ERROR_PARSE, 'Тело запроса — не JSON');
	}
	// A batch was dropped from the protocol in 2025-06-18, and the clients that speak 2025-03-26 do not send one
	if (!message || typeof message !== 'object' || Array.isArray(message)) {
		return errorReply(null, JSON_RPC_ERROR_INVALID_REQUEST, 'Ждём одно сообщение JSON-RPC, не пакет');
	}
	const record = message as Record<string, JsonValue>;
	const method = typeof record['method'] === 'string' ? record['method'] : undefined;
	const id = record['id'];
	const hasId = typeof id === 'number' || typeof id === 'string';
	if (!method) {
		// A response to something the server never asked: nothing waits for it
		return hasId ? errorReply(id, JSON_RPC_ERROR_INVALID_REQUEST, 'Нет поля method') : { status: 202 };
	}
	// A notification is answered by the status alone
	if (!hasId) {
		return { status: 202 };
	}
	const params = typeof record['params'] === 'object' && record['params'] !== null && !Array.isArray(record['params'])
		? record['params'] as Record<string, JsonValue>
		: {};

	switch (method) {
		case 'initialize': {
			const asked = params['protocolVersion'];
			return resultReply(id, {
				protocolVersion: typeof asked === 'string' && IDE_MCP_PROTOCOL_VERSIONS.includes(asked) ? asked : IDE_MCP_PROTOCOL_VERSIONS[1],
				capabilities: { tools: {} },
				serverInfo: { name: IDE_MCP_SERVER_NAME, version: '1' },
			});
		}
		case 'ping':
			return resultReply(id, {});
		case 'tools/list':
			return resultReply(id, { tools: IDE_MCP_TOOLS.map(tool => ({ name: tool.name, title: tool.title, description: tool.description, inputSchema: tool.inputSchema })) });
		case 'tools/call': {
			const name = params['name'];
			if (typeof name !== 'string' || !IDE_MCP_TOOLS.some(tool => tool.name === name)) {
				return errorReply(id, JSON_RPC_ERROR_INVALID_PARAMS, `Неизвестный инструмент: ${typeof name === 'string' ? name : '—'}`);
			}
			const args = typeof params['arguments'] === 'object' && params['arguments'] !== null && !Array.isArray(params['arguments'])
				? params['arguments'] as Record<string, JsonValue>
				: {};
			try {
				const result = await call(name, args);
				return resultReply(id, { content: [{ type: 'text', text: result.text }], isError: result.isError === true });
			} catch (err) {
				return errorReply(id, JSON_RPC_ERROR_INTERNAL, err instanceof Error ? err.message : String(err));
			}
		}
		default:
			return errorReply(id, JSON_RPC_ERROR_METHOD_NOT_FOUND, `Метод ${method} не поддерживается`);
	}
}

// ── Answers ──────────────────────────────────────────────────────────────────

/** The part of a file the person selected */
export interface IIdeSelection {
	readonly startLine: number;
	readonly endLine: number;
	readonly text: string;
}

/** The editor as one tool call finds it; the caller has already left out what `.vibe/ignore` closes */
export interface IIdeEditorFacts {
	readonly activeFile?: {
		readonly path: string;
		readonly languageId?: string;
		/** The document's text, unsaved edits included */
		readonly text: string;
		readonly selection?: IIdeSelection;
	};
	readonly otherTabs: readonly string[];
}

const fenced = (text: string): string => `\`\`\`\n${text}\n\`\`\``;

/**
 * The answer of `vibe_open_file`
 * The text is cut at `maxChars` and the cut is named: a file that looks whole when it is not makes the agent
 * rewrite a file it has not finished reading
 */
export function formatOpenFile(facts: IIdeEditorFacts, maxChars: number, redact: (text: string) => string): string {
	const active = facts.activeFile;
	const tabs = facts.otherTabs.slice(0, IDE_MCP_MAX_TABS);
	const hidden = facts.otherTabs.length - tabs.length;
	const tabsLine = tabs.length > 0
		? `Другие открытые вкладки:\n${tabs.join('\n')}${hidden > 0 ? `\n... и ещё ${hidden}` : ''}`
		: 'Других открытых вкладок нет.';
	if (!active) {
		return `В редакторе не открыт ни один файл.\n\n${tabsLine}`;
	}
	const lines = [`Открытый файл: ${active.path}${active.languageId ? ` (${active.languageId})` : ''}`];
	if (active.selection) {
		const { startLine, endLine, text } = active.selection;
		lines.push('', `Выделено человеком: строки ${startLine}-${endLine}`, fenced(redact(text)));
	} else {
		lines.push('', 'Выделения нет.');
	}
	// Masked before the cut: a key split by the cut would be left half-written, and half a key is not recognized as one
	const text = redact(active.text);
	const cut = text.length > maxChars;
	lines.push(
		'',
		cut ? `Текст файла (первые ${maxChars} из ${text.length} знаков, остальное обрезано):` : 'Текст файла:',
		fenced(cut ? text.slice(0, maxChars) : text),
		'',
		tabsLine,
	);
	return lines.join('\n');
}

export type IdeProblemSeverity = 'error' | 'warning' | 'info';

export interface IIdeProblem {
	readonly line: number;
	readonly severity: IdeProblemSeverity;
	readonly message: string;
	/** The language server that raised it (`ts`, `eslint`), when it says */
	readonly source?: string;
	/** The text of the line the problem is on */
	readonly lineText: string;
}

/**
 * What the editor knows about a file's problems
 * Each state has its own answer: «no markup because the file is not open» must not read as «no errors»
 */
export type IdeProblemsOutcome =
	| { readonly kind: 'found'; readonly path: string; readonly problems: readonly IIdeProblem[] }
	/** The file is not open, so there is no markup: an empty list here would read as «no errors» */
	| { readonly kind: 'notOpen'; readonly path: string }
	| { readonly kind: 'closed'; readonly path: string }
	| { readonly kind: 'noFile' };

const SEVERITY_NAMES: Record<IdeProblemSeverity, string> = { error: 'ошибка', warning: 'предупреждение', info: 'сведение' };

/** The answer of `vibe_problems`: a line per problem, `line: [severity] message  |  the text of the line` */
export function formatProblems(outcome: IdeProblemsOutcome): string {
	switch (outcome.kind) {
		case 'noFile':
			return 'Путь не указан, и в редакторе нет открытого файла.';
		case 'notOpen':
			return `Файл ${outcome.path} не открыт в редакторе: разметка ошибок есть только у открытых файлов. Попросите человека открыть его и спросите снова. Это не значит, что ошибок нет.`;
		case 'closed':
			return `Файл ${outcome.path} закрыт для агента правилом .vibe/ignore.`;
		case 'found': {
			if (outcome.problems.length === 0) {
				return `В ${outcome.path} редактор ничего не подчеркнул.`;
			}
			const shown = outcome.problems.slice(0, IDE_MCP_MAX_PROBLEMS);
			const rows = shown.map(problem => {
				const source = problem.source ? ` (${problem.source})` : '';
				return `${problem.line}: [${SEVERITY_NAMES[problem.severity]}] ${problem.message}${source}  |  ${problem.lineText.trim().slice(0, PROBLEM_LINE_CHARS)}`;
			});
			const more = outcome.problems.length - shown.length;
			return [`Проблемы файла ${outcome.path}:`, ...rows, ...(more > 0 ? [`... и ещё ${more}`] : [])].join('\n');
		}
	}
}
