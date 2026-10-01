/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * The markups open model families write tool calls in, as their chat templates and vLLM's parsers define them
 *
 * Each form follows the vendor's template or encoder and vLLM's grammar (`vllm/parser/`, `rust/src/parser/src/tool/`)
 * The same forms are read by VibeIDEA: the contract is `.vibe-defaults/testVectors/textToolCalls.json`
 *
 * Values in a markup that carries no type (Qwen XML, GLM, MiniMax, Gemma) are typed by the tool's schema,
 * the way vLLM does it: a model writes `40` for a `limit` and means a number
 */

/** A JSON value as call arguments carry it */
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | JsonObject;

/** A JSON object as call arguments carry it */
export interface JsonObject {
	[key: string]: JsonValue;
}

/** The part of a tool's JSON schema that types the values a markup writes without a type */
export interface TextToolCallSchema {
	readonly type?: string | readonly string[];
	readonly nullable?: boolean | string;
	readonly properties?: { readonly [key: string]: TextToolCallSchema };
	readonly items?: TextToolCallSchema;
	readonly anyOf?: readonly TextToolCallSchema[];
	readonly oneOf?: readonly TextToolCallSchema[];
}

/** A tool call read from markup: the name as written and its arguments */
export interface TextToolCall {
	readonly name: string;
	readonly arguments: JsonObject;
}

/** Calls read from markup and the text left around them */
interface TextToolCallsFound {
	readonly calls: readonly TextToolCall[];
	readonly rest: string;
}

/** Tool name → its JSON schema, which types the values a markup writes without a type */
type TextToolCallSchemas = (tool: string) => TextToolCallSchema | undefined;

/** One family's markup: where it opens and how its calls read */
export interface TextToolCallFormat {
	/** The name the log and the vectors know it by */
	readonly id: string;
	/** Literal openers a stream cut after their first characters waits for */
	readonly openers: readonly string[];
	/**
	 * Where this markup opens in `text` at or after `from`, or -1
	 * `atAnswerStart`: `text` begins the answer, nothing but blanks came before it
	 * The forms that are the whole answer need it
	 */
	open(text: string, from: number, atAnswerStart: boolean): number;
	/** The calls in `markup`, which starts at the opener, and the text around them; undefined when it does not read */
	read(markup: string, schemas: TextToolCallSchemas): TextToolCallsFound | undefined;
}

// ---------- JSON helpers ----------

/** Sets a member as an own property: a key such as `__proto__` from the model must not reach the prototype */
function setMember(target: JsonObject, key: string, value: JsonValue): void {
	Object.defineProperty(target, key, { value, enumerable: true, writable: true, configurable: true });
}

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
	return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The JSON value of `text`, or undefined when it is not JSON; `null` is a value, not a failure */
function parseJson(text: string): JsonValue | undefined {
	try {
		return JSON.parse(text) as JsonValue;
	} catch {
		return undefined;
	}
}

/** A JSON object from `text`, or undefined when it is not one */
function jsonObject(text: string): JsonObject | undefined {
	const value = parseJson(text.trim());
	return isJsonObject(value) ? value : undefined;
}

type SchemaProperties = NonNullable<TextToolCallSchema['properties']>;

/** A schema node is an object; a node of another shape (a tool's schema is foreign data) types nothing */
const isSchemaNode = (value: unknown): boolean => value !== null && typeof value === 'object' && !Array.isArray(value);

function asSchema(value: TextToolCallSchema | undefined): TextToolCallSchema | undefined {
	return isSchemaNode(value) ? value : undefined;
}

function propertiesOf(schema: TextToolCallSchema | undefined): SchemaProperties | undefined {
	const properties = schema?.properties;
	return isSchemaNode(properties) ? properties : undefined;
}

/** The schema of a member, read as an own property only */
function memberSchema(properties: SchemaProperties | undefined, key: string): TextToolCallSchema | undefined {
	return properties && Object.hasOwn(properties, key) ? asSchema(properties[key]) : undefined;
}

const INTEGER_RE = /^[+-]?\d+$/;
// Decimal notation only: no hex, no type suffixes, no NaN or Infinity
const NUMBER_RE = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/** A negative zero compares unequal to zero in strict equality, and JSON has only one zero */
const plainZero = (n: number): number => n === 0 ? 0 : n;

/** An integer written in decimal that a double holds exactly, or undefined */
function parseInteger(text: string): number | undefined {
	if (!INTEGER_RE.test(text)) {
		return undefined;
	}
	const n = Number(text);
	return Number.isSafeInteger(n) ? plainZero(n) : undefined;
}

/** A finite number written in decimal notation, or undefined */
function parseNumber(text: string): number | undefined {
	if (!NUMBER_RE.test(text)) {
		return undefined;
	}
	const n = Number(text);
	return Number.isFinite(n) ? plainZero(n) : undefined;
}

const isWhitespace = (c: string | undefined): boolean => c !== undefined && /\s/.test(c);
const isLetterOrDigit = (c: string): boolean => /[\p{L}\p{Nd}]/u.test(c);
const isBlank = (text: string): boolean => text.trim().length === 0;

/** The text before the first `delimiter`, or the whole text without one */
function before(text: string, delimiter: string): string {
	const at = text.indexOf(delimiter);
	return at < 0 ? text : text.slice(0, at);
}

function removeSurrounding(text: string, delimiter: string): string {
	return text.length >= delimiter.length * 2 && text.startsWith(delimiter) && text.endsWith(delimiter)
		? text.slice(delimiter.length, text.length - delimiter.length)
		: text;
}

/** Where `pattern` (a global expression) next matches in `text` at or after `from`, or -1 */
function indexFrom(pattern: RegExp, text: string, from: number): number {
	pattern.lastIndex = from;
	return pattern.exec(text)?.index ?? -1;
}

// ---------- Values by schema ----------

/** The order vLLM's `coerce_to_schema_type` tries a schema's types in */
const TYPE_ORDER = ['null', 'integer', 'number', 'boolean', 'object', 'array', 'string'];

/** The types a schema allows, in vLLM's order: `type` as a word or a list, `nullable`, the types of `anyOf`/`oneOf` */
function schemaTypes(schema: TextToolCallSchema | undefined): string[] {
	if (!schema) {
		return [];
	}
	const found = new Set<string>();
	const collect = (node: TextToolCallSchema) => {
		if (typeof node.type === 'string') {
			found.add(node.type);
		} else if (Array.isArray(node.type)) {
			node.type.filter(type => typeof type === 'string').forEach(type => found.add(type));
		}
		if (node.nullable === true || node.nullable === 'true') {
			found.add('null');
		}
		for (const variants of [node.anyOf, node.oneOf]) {
			if (Array.isArray(variants)) {
				variants.forEach(variant => {
					if (isSchemaNode(variant)) {
						collect(variant);
					}
				});
			}
		}
	};
	collect(schema);
	return TYPE_ORDER.filter(type => found.has(type));
}

/**
 * A value written as text, typed by its JSON schema, by vLLM's rule (`coerce_to_schema_type`)
 * The first of the schema's types that fits wins
 * No schema — a string; a schema none of whose types fits and that has no string — JSON if it is JSON, else the text
 */
function coerce(raw: string, schema: TextToolCallSchema | undefined): JsonValue {
	const types = schemaTypes(schema);
	if (types.length === 0) {
		return raw;
	}
	const trimmed = raw.trim();
	for (const type of types) {
		switch (type) {
			case 'null':
				if (trimmed.toLowerCase() === 'null') {
					return null;
				}
				break;
			case 'integer': {
				const n = parseInteger(trimmed);
				if (n !== undefined) {
					return n;
				}
				break;
			}
			case 'number': {
				const n = parseNumber(trimmed);
				if (n !== undefined) {
					return n;
				}
				break;
			}
			case 'boolean': {
				const word = trimmed.toLowerCase();
				if (word === 'true' || word === '1') {
					return true;
				}
				if (word === 'false' || word === '0') {
					return false;
				}
				break;
			}
			case 'object': {
				const object = jsonObject(trimmed);
				if (object) {
					return object;
				}
				break;
			}
			case 'array': {
				const array = parseJson(trimmed);
				if (Array.isArray(array)) {
					return array;
				}
				break;
			}
			case 'string':
				return raw;
		}
	}
	const json = parseJson(trimmed);
	return json === undefined ? raw : json;
}

// ---------- The first JSON value in a text ----------

/** The first JSON value in `text` from `from` on, as Python's `raw_decode` finds it: the value and where it ends */
function jsonValueAt(text: string, from: number): { readonly value: JsonValue; readonly end: number } | undefined {
	let at = from;
	while (at < text.length && isWhitespace(text[at])) {
		at++;
	}
	if (at >= text.length) {
		return undefined;
	}
	let end: number;
	if (text[at] === '{' || text[at] === '[') {
		end = balancedEnd(text, at);
	} else if (text[at] === '"') {
		end = stringEnd(text, at);
	} else {
		end = at;
		while (end < text.length && !',;}] \n\t\r'.includes(text[end])) {
			end++;
		}
	}
	if (end <= at || end > text.length) {
		return undefined;
	}
	const value = parseJson(text.slice(at, end));
	return value === undefined ? undefined : { value, end };
}

function balancedEnd(text: string, from: number): number {
	let depth = 0;
	for (let i = from; i < text.length; i++) {
		const c = text[i];
		if (c === '"') {
			i = stringEnd(text, i) - 1;
		} else if (c === '{' || c === '[') {
			depth++;
		} else if (c === '}' || c === ']') {
			if (--depth === 0) {
				return i + 1;
			}
		}
	}
	return -1;
}

/** Just past the string's closing quote; past the end of the text when it never closes */
function stringEnd(text: string, from: number): number {
	for (let i = from + 1; i < text.length; i++) {
		if (text[i] === '\\') {
			i++;
		} else if (text[i] === '"') {
			return i + 1;
		}
	}
	return text.length + 1;
}

// ---------- Format shapes ----------

/** A format recognised by a regular expression (global) at any place outside code */
function opened(id: string, opener: RegExp, openers: readonly string[], read: TextToolCallFormat['read']): TextToolCallFormat {
	return { id, openers, open: (text, from) => indexFrom(opener, text, from), read };
}

/** A format that is the whole answer or nothing: bare JSON or a Python list, allowed only where the answer begins */
function wholeAnswer(id: string, opener: RegExp, read: TextToolCallFormat['read']): TextToolCallFormat {
	return {
		id,
		openers: [],
		open: (text, from, atAnswerStart) => {
			if (!atAnswerStart || from > 0) {
				return -1;
			}
			// The markup starts at its first character, not at the blanks the pattern allows before it
			const match = opener.exec(text);
			return match ? match.index + match[0].search(/\S/) : -1;
		},
		read,
	};
}

/** The first non-empty of three alternative groups: a name in double quotes, single quotes or none */
function nameOf(match: RegExpMatchArray, first: number): string {
	return (match[first] || match[first + 1] || match[first + 2] || '').trim();
}

// ---------- One invoke grammar ----------
// DeepSeek V3.2 / V4 / V4.1 (DSML), `<invoke>` without a family's marker, MiniMax M2

/** Vendor markers around a tag name: `｜DSML｜`, fullwidth pipes only; an ASCII pair would match inside a value */
const DSML_MARKER = /｜{1,4}\p{L}[\p{L}\p{N}_-]*｜{1,4}/gu;

/** Tag names of the invoke grammar: the call, its parameters and the wrappers vendors put around calls */
const INVOKE_TAGS = 'function_calls|tool_calls|toolcalls|calls|tool|invoke|parameter';

/** A tag name after `<` or `</` with the space V4.1 writes after its marker or a lost marker leaves */
const SPACED = new RegExp(`<\\s*(/?)\\s*(${INVOKE_TAGS})\\b`, 'g');

const INVOKE_WRAPPER = /<\/?(?:function_calls|tool_calls|toolcalls|calls|tool|minimax:tool_call)\s*>/g;
const INVOKE = /<invoke\s+name=(?:"([^"]*)"|'([^']*)'|([^\s>]+))\s*>(.*?)<\/invoke\s*>/gs;
const PARAMETER = /<parameter\s+name=(?:"([^"]*)"|'([^']*)'|([^\s>]+))(?:\s+string="(true|false)")?\s*>(.*?)(?:<\/parameter\s*>|(?=<parameter\s))/gs;

/**
 * Calls of the invoke grammar in markup already free of markers
 * `string="true"` is a string as written, `string="false"` is JSON
 * A parameter without the attribute is typed by the schema
 */
function readInvokes(markup: string, schemas: TextToolCallSchemas): TextToolCallsFound | undefined {
	const calls: TextToolCall[] = [];
	for (const invoke of markup.matchAll(INVOKE)) {
		const name = nameOf(invoke, 1);
		const properties = propertiesOf(schemas(name));
		const args: JsonObject = {};
		for (const parameter of invoke[4].matchAll(PARAMETER)) {
			const key = nameOf(parameter, 1);
			const value = parameter[5];
			if (parameter[4] === 'true') {
				setMember(args, key, value);
			} else if (parameter[4] === 'false') {
				const json = parseJson(value.trim());
				if (json === undefined) {
					return undefined;
				}
				setMember(args, key, json);
			} else {
				setMember(args, key, coerce(value, memberSchema(properties, key)));
			}
		}
		calls.push({ name, arguments: args });
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.replace(INVOKE, '').replace(INVOKE_WRAPPER, '') };
}

/** DeepSeek's DSML with its marker, and the same with the marker lost on the way (`< invoke name=…>`) */
const DSML = opened(
	'dsml',
	/<\s*｜{1,4}DSML｜{1,4}\s*(?:function_calls|tool_calls|toolcalls|tool|calls|invoke)\b|<\s+(?:function_calls|tool_calls|calls|invoke)\b/g,
	['<｜DSML｜'],
	(markup, schemas) => readInvokes(markup.replace(DSML_MARKER, '').replace(SPACED, (_, slash: string, tag: string) => `<${slash}${tag}`), schemas),
);

/** `<invoke name=…>` with no family's marker: DeepSeek V3.2 once a server strips `｜DSML｜`, Anthropic-style XML */
const INVOKE_XML = opened(
	'invoke',
	/<(?:function_calls|tool_calls)\s*>|<invoke\s+name=/g,
	['<function_calls>', '<tool_calls>', '<invoke name='],
	readInvokes,
);

const MINIMAX_M2 = opened('minimax-m2', /<minimax:tool_call>/g, ['<minimax:tool_call>'], readInvokes);

// ---------- MiniMax M3: every structural tag behind a namespace prefix, nested arguments as elements ----------

const M3_PREFIX = ']<]minimax[>[';
const M3_TAG = /<(\/?)([^\s>/]+)(?:\s+name=(?:"([^"]*)"|'([^']*)'|([^\s>]*)))?\s*>/y;

interface M3Element {
	readonly name: string;
	readonly attribute: string | undefined;
	readonly children: M3Element[];
	text: string;
}

const m3Element = (name: string, attribute: string | undefined): M3Element => ({ name, attribute, children: [], text: '' });

/** The children of `element` as object members; a key written twice becomes an array */
function m3Members(element: M3Element, schemaOf: (key: string) => TextToolCallSchema | undefined): JsonObject {
	const grouped = new Map<string, JsonValue[]>();
	for (const child of element.children) {
		const values = grouped.get(child.name) ?? [];
		values.push(m3Value(child, schemaOf(child.name)));
		grouped.set(child.name, values);
	}
	const members: JsonObject = {};
	for (const [key, values] of grouped) {
		setMember(members, key, values.length === 1 ? values[0] : values);
	}
	return members;
}

function m3Value(element: M3Element, schema: TextToolCallSchema | undefined): JsonValue {
	if (element.children.length === 0) {
		return coerce(element.text, schema);
	}
	if (schemaTypes(schema)[0] === 'array') {
		const items = asSchema(schema?.items);
		return element.children.map(child => m3Value(child, items));
	}
	const properties = propertiesOf(schema);
	return m3Members(element, key => memberSchema(properties, key));
}

const MINIMAX_M3 = opened('minimax-m3', /\]<\]minimax\[>\[<tool_call>/g, [`${M3_PREFIX}<tool_call>`], (markup, schemas) => {
	const root = m3Element('', undefined);
	const stack = [root];
	let at = 0;
	let end = markup.length;
	while (at < markup.length) {
		const next = markup.indexOf(M3_PREFIX, at);
		if (next < 0) {
			if (stack.length > 1) {
				return undefined;
			}
			end = at;
			break;
		}
		stack[stack.length - 1].text += markup.slice(at, next);
		M3_TAG.lastIndex = next + M3_PREFIX.length;
		const tag = M3_TAG.exec(markup);
		if (!tag) {
			return undefined;
		}
		const name = tag[2];
		const tagEnd = tag.index + tag[0].length;
		if (!tag[1]) {
			const element = m3Element(name, nameOf(tag, 3) || undefined);
			stack[stack.length - 1].children.push(element);
			stack.push(element);
		} else {
			if (stack.length < 2 || stack[stack.length - 1].name !== name) {
				return undefined;
			}
			stack.pop();
			if (stack.length === 1 && name === 'tool_call') {
				end = tagEnd;
				break;
			}
		}
		at = tagEnd;
	}
	const blocks = root.children.filter(child => child.name === 'tool_call');
	if (blocks.length !== 1) {
		return undefined;
	}
	const calls: TextToolCall[] = [];
	for (const invoke of blocks[0].children.filter(child => child.name === 'invoke')) {
		if (invoke.attribute === undefined) {
			return undefined;
		}
		const properties = propertiesOf(schemas(invoke.attribute));
		calls.push({ name: invoke.attribute, arguments: m3Members(invoke, key => memberSchema(properties, key)) });
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: root.text + markup.slice(end) };
});

// ---------- DeepSeek V3 / R1 (JSON in a fence after the type) and V3.1 (JSON right after the name) ----------

const DEEPSEEK_V3_CALL = /<｜tool▁call▁begin｜>(.*?)<｜tool▁sep｜>(.*?)<｜tool▁call▁end｜>/gs;
const DEEPSEEK_V3_SECTION = /<｜tool▁calls▁(?:begin|end)｜>/g;
const JSON_FENCE = /^\s*```(?:json)?\s*(.*?)\s*```\s*$/s;

const DEEPSEEK_V3 = opened(
	'deepseek-v3',
	/<｜tool▁calls?▁begin｜>/g,
	['<｜tool▁calls▁begin｜>', '<｜tool▁call▁begin｜>'],
	markup => {
		const calls: TextToolCall[] = [];
		for (const call of markup.matchAll(DEEPSEEK_V3_CALL)) {
			const head = call[1].trim();
			const body = call[2];
			if (body.trimStart().startsWith('{')) {
				const args = jsonObject(body);
				if (!args) {
					return undefined;
				}
				calls.push({ name: head, arguments: args });
			} else {
				const lineEnd = body.indexOf('\n');
				const json = JSON_FENCE.exec(lineEnd < 0 ? '' : body.slice(lineEnd + 1))?.[1];
				const args = json === undefined ? undefined : jsonObject(json);
				if (!args) {
					return undefined;
				}
				calls.push({ name: before(body, '\n').trim(), arguments: args });
			}
		}
		if (calls.length === 0) {
			return undefined;
		}
		return { calls, rest: markup.replace(DEEPSEEK_V3_CALL, '').replace(DEEPSEEK_V3_SECTION, '') };
	},
);

// ---------- `<tool_call>` opens four families; what follows the tag tells them apart ----------

const TOOL_CALL = '<tool_call>';
const TOOL_CALL_OPEN = /<tool_call>/g;
const TOOL_CALL_BLOCK = /<tool_call>(.*?)(?:<\/tool_call>|(?=<tool_call>)|$)/gs;

/** A call object of the JSON families: `name` and `arguments` (or Llama's `parameters`), arguments maybe a string */
function jsonCall(value: JsonValue): TextToolCall | undefined {
	const name = isJsonObject(value) && Object.hasOwn(value, 'name') ? value.name : undefined;
	if (!isJsonObject(value) || typeof name !== 'string') {
		return undefined;
	}
	const raw = Object.hasOwn(value, 'arguments') ? value.arguments : Object.hasOwn(value, 'parameters') ? value.parameters : undefined;
	if (raw === undefined || raw === null) {
		return { name, arguments: {} };
	}
	if (isJsonObject(raw)) {
		return { name, arguments: raw };
	}
	const args = typeof raw === 'string' ? jsonObject(raw) : undefined;
	return args ? { name, arguments: args } : undefined;
}

/** Calls in a JSON value: one call object or an array of them */
function jsonCalls(value: JsonValue): TextToolCall[] | undefined {
	if (!Array.isArray(value)) {
		const call = jsonCall(value);
		return call ? [call] : undefined;
	}
	const calls: TextToolCall[] = [];
	for (const item of value as readonly JsonValue[]) {
		const call = jsonCall(item);
		if (!call) {
			return undefined;
		}
		calls.push(call);
	}
	return calls.length > 0 ? calls : undefined;
}

/** Hermes 2 Pro, Qwen 2.5 and Qwen 3, Granite 3.1 and 4: a JSON object (or a list of them) inside `<tool_call>` */
const HERMES = opened('hermes', TOOL_CALL_OPEN, [TOOL_CALL], markup => {
	const calls: TextToolCall[] = [];
	for (const block of markup.matchAll(TOOL_CALL_BLOCK)) {
		const body = block[1].trim();
		if (!body.startsWith('{') && !body.startsWith('[')) {
			return undefined;
		}
		const value = parseJson(body);
		const found = value === undefined ? undefined : jsonCalls(value);
		if (!found) {
			return undefined;
		}
		calls.push(...found);
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.replace(TOOL_CALL_BLOCK, '') };
});

const QWEN_WRAPPER = /<\/?(?:seed:)?tool_call>/g;
const QWEN_FUNCTION = /<function=([^>\n]+)>(.*?)(?:<\/function>|(?=<function=)|$)/gs;
const QWEN_PARAMETER = /<\s*parameter\s*=\s*([^>]*)>(.*?)(?:<\s*\/\s*parameter\s*>|(?=<\s*parameter\s*=)|$)/gs;
const QWEN_OPENER = /<(?:seed:)?tool_call>\s*<function=|<function=[^>\n]+>/g;

/** The template wraps a value in one line break each side; the value's own breaks stay */
function trimWrappingNewlines(value: string): string {
	const start = value.startsWith('\n') ? 1 : 0;
	const end = value.length > start && value.endsWith('\n') ? value.length - 1 : value.length;
	return value.slice(start, end);
}

/** Qwen3-Coder and Qwen 3.5+ (`<tool_call><function=…><parameter=…>`), Seed-OSS in `<seed:tool_call>` */
const QWEN_XML: TextToolCallFormat = {
	id: 'qwen-xml',
	openers: ['<seed:tool_call>', '<function='],
	open: (text, from) => {
		// A bare `<tool_call>` still waiting for its body is claimed here too, so the stream holds it
		const found = [indexFrom(TOOL_CALL_OPEN, text, from), indexFrom(QWEN_OPENER, text, from)].filter(at => at >= 0);
		return found.length > 0 ? Math.min(...found) : -1;
	},
	read: (markup, schemas) => {
		const calls: TextToolCall[] = [];
		for (const fn of markup.matchAll(QWEN_FUNCTION)) {
			const name = fn[1].trim();
			const properties = propertiesOf(schemas(name));
			const args: JsonObject = {};
			for (const parameter of fn[2].matchAll(QWEN_PARAMETER)) {
				const key = parameter[1].trim();
				setMember(args, key, coerce(trimWrappingNewlines(parameter[2]), memberSchema(properties, key)));
			}
			calls.push({ name, arguments: args });
		}
		if (calls.length === 0) {
			return undefined;
		}
		return { calls, rest: markup.replace(QWEN_FUNCTION, '').replace(QWEN_WRAPPER, '') };
	},
};

const GLM_BLOCK = /<tool_call>(.*?)(?:<\/tool_call>|$)/gs;
const GLM_ARGUMENT = /<arg_key>(.*?)<\/arg_key>\s*<arg_value>(.*?)<\/arg_value>/gs;
const GLM_NAME = /^[\p{L}\p{N}_.:-]+$/u;

/** GLM 4.5 and newer: the name right after `<tool_call>`, then `<arg_key>`/`<arg_value>` pairs */
const GLM = opened('glm', TOOL_CALL_OPEN, [TOOL_CALL], (markup, schemas) => {
	const calls: TextToolCall[] = [];
	for (const block of markup.matchAll(GLM_BLOCK)) {
		const body = block[1];
		const name = before(body, '<arg_key>').trim();
		if (!GLM_NAME.test(name)) {
			return undefined;
		}
		const properties = propertiesOf(schemas(name));
		const args: JsonObject = {};
		for (const pair of body.matchAll(GLM_ARGUMENT)) {
			const key = pair[1].trim();
			setMember(args, key, coerce(pair[2], memberSchema(properties, key)));
		}
		calls.push({ name, arguments: args });
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.replace(GLM_BLOCK, '') };
});

// ---------- Kimi K2 (sections of calls named `functions.name:index`) and Kimi K3 (XTML channels) ----------

const KIMI_K2_CALL = /<\|tool_call_begin\|>\s*([^\s<]+?)\s*<\|tool_call_argument_begin\|>\s*(.*?)\s*<\|tool_call_end\|>/gs;
const KIMI_K2_SECTION = /<\|tool_calls_section_(?:begin|end)\|>/g;
const KIMI_K2_INDEX = /:\d+$/;
const FUNCTIONS_PREFIX = 'functions.';

const KIMI_K2 = opened(
	'kimi-k2',
	/<\|tool_calls_section_begin\|>|<\|tool_call_begin\|>/g,
	['<|tool_calls_section_begin|>', '<|tool_call_begin|>'],
	markup => {
		const calls: TextToolCall[] = [];
		for (const call of markup.matchAll(KIMI_K2_CALL)) {
			const indexed = call[1].replace(KIMI_K2_INDEX, '');
			const name = indexed.startsWith(FUNCTIONS_PREFIX) ? indexed.slice(FUNCTIONS_PREFIX.length) : indexed;
			const args = jsonObject(isBlank(call[2]) ? '{}' : call[2]);
			if (!args) {
				return undefined;
			}
			calls.push({ name, arguments: args });
		}
		if (calls.length === 0) {
			return undefined;
		}
		return { calls, rest: markup.replace(KIMI_K2_CALL, '').replace(KIMI_K2_SECTION, '') };
	},
);

const K3_OPEN = '<\\|open\\|>\\s*';
const K3_SEP = '\\s*<\\|sep\\|>';
const K3_CLOSE = '<\\|close\\|>\\s*';
const K3_TOOLS = new RegExp(`${K3_OPEN}tools${K3_SEP}(.*?)(?:${K3_CLOSE}tools${K3_SEP}|$)`, 'gs');
const K3_CALL = new RegExp(`${K3_OPEN}call\\s+([^<]*?)${K3_SEP}(.*?)${K3_CLOSE}call${K3_SEP}`, 'gs');
const K3_ARGUMENT = new RegExp(`${K3_OPEN}argument\\s+([^<]*?)${K3_SEP}(.*?)${K3_CLOSE}argument${K3_SEP}`, 'gs');
const K3_JSON = new RegExp(`${K3_OPEN}json\\b[^<]*?${K3_SEP}(.*?)${K3_CLOSE}json${K3_SEP}`, 's');
const K3_CHANNEL = new RegExp(`<\\|(?:open|close)\\|>\\s*(?:response|message)${K3_SEP}`, 'g');
const K3_ATTRIBUTE = /(\w+)="([^"]*)"/g;

function k3Attributes(text: string): Map<string, string> {
	const attributes = new Map<string, string>();
	for (const attribute of text.matchAll(K3_ATTRIBUTE)) {
		attributes.set(attribute[1], attribute[2].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
	}
	return attributes;
}

const KIMI_K3 = opened(
	'kimi-k3',
	/(?:<\|close\|>\s*response\s*<\|sep\|>\s*)?<\|open\|>\s*(?:tools\s*<\|sep\|>|call\s)/g,
	['<|close|>response<|sep|><|open|>tools<|sep|>', '<|open|>tools<|sep|>', '<|open|>call '],
	markup => {
		const calls: TextToolCall[] = [];
		for (const call of markup.matchAll(K3_CALL)) {
			const name = k3Attributes(call[1]).get('tool');
			if (name === undefined) {
				return undefined;
			}
			const body = call[2];
			const raw = K3_JSON.exec(body)?.[1];
			let args: JsonObject | undefined;
			if (raw !== undefined) {
				args = jsonObject(raw);
			} else {
				args = {};
				for (const argument of body.matchAll(K3_ARGUMENT)) {
					const attributes = k3Attributes(argument[1]);
					const key = attributes.get('key');
					if (key === undefined) {
						return undefined;
					}
					const value = argument[2];
					const json = attributes.get('type') === 'string' ? undefined : parseJson(value);
					setMember(args, key, json === undefined ? value : json);
				}
			}
			if (!args) {
				return undefined;
			}
			calls.push({ name, arguments: args });
		}
		if (calls.length === 0) {
			return undefined;
		}
		return { calls, rest: markup.replace(K3_CALL, '').replace(K3_TOOLS, '').replace(K3_CHANNEL, '') };
	},
);

// ---------- Mistral ----------
// `[TOOL_CALLS]` with a JSON list (tokenizers v2–v7) or `name[ARGS]{…}` per call (v11 and newer)

const MISTRAL_CALLS = '[TOOL_CALLS]';

const MISTRAL = opened('mistral', /\[TOOL_CALLS\]/g, [MISTRAL_CALLS], markup => {
	const calls: TextToolCall[] = [];
	let at = markup.indexOf(MISTRAL_CALLS);
	let end = at;
	while (at >= 0) {
		let from = at + MISTRAL_CALLS.length;
		while (from < markup.length && isWhitespace(markup[from])) {
			from++;
		}
		if (markup.startsWith('[', from)) {
			const json = jsonValueAt(markup, from);
			const found = json && jsonCalls(json.value);
			if (!json || !found) {
				return undefined;
			}
			calls.push(...found);
			end = json.end;
		} else {
			const argsAt = markup.indexOf('{', from);
			if (argsAt < 0) {
				return undefined;
			}
			const name = before(before(markup.slice(from, argsAt), '[CALL_ID]'), '[ARGS]').trim();
			const json = jsonValueAt(markup, argsAt);
			if (!json || !isJsonObject(json.value)) {
				return undefined;
			}
			calls.push({ name, arguments: json.value });
			end = json.end;
		}
		// The next call opens with its own marker; words in between end the calls
		const next = markup.indexOf(MISTRAL_CALLS, end);
		at = next >= 0 && isBlank(markup.slice(end, next)) ? next : -1;
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.slice(end) };
});

// ---------- Llama and the bare JSON forms ----------
// A server that strips `<|python_tag|>`, `[TOOL_CALLS]` or `<|tool_call|>` leaves JSON

/** JSON calls from `from` on, one after another, separated by blanks, `;` or `,`; with the text after the last */
function jsonCallsFrom(markup: string, from: number): TextToolCallsFound | undefined {
	const calls: TextToolCall[] = [];
	let at = from;
	let end = from;
	while (true) {
		while (at < markup.length && (isWhitespace(markup[at]) || markup[at] === ';' || markup[at] === ',')) {
			at++;
		}
		if (at >= markup.length || (markup[at] !== '{' && markup[at] !== '[')) {
			break;
		}
		const json = jsonValueAt(markup, at);
		if (!json) {
			break;
		}
		const found = jsonCalls(json.value);
		if (!found) {
			return undefined;
		}
		calls.push(...found);
		at = json.end;
		end = at;
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.slice(end) };
}

const PYTHON_TAG = '<|python_tag|>';

/** Llama 3.x behind `<|python_tag|>`: JSON with `parameters` */
const LLAMA = opened('llama', /<\|python_tag\|>/g, [PYTHON_TAG], markup => {
	const tag = markup.indexOf(PYTHON_TAG);
	return tag < 0 ? undefined : jsonCallsFrom(markup, tag + PYTHON_TAG.length);
});

/** The answer is JSON calls and nothing before them: Llama 3.x without its tag, Mistral or Granite 3 stripped */
const JSON_ANSWER = wholeAnswer('json', /^\s*\[?\s*\{\s*"name"\s*:/, markup => jsonCallsFrom(markup, 0));

/** Granite 3.x: `<|tool_call|>` and a JSON list; Granite 20B: `<function_call>` and one object per call */
const GRANITE_TAG = /^\s*(?:<\|tool_call\|>|<function_call>)/;

const GRANITE = opened('granite', /<\|tool_call\|>|<function_call>/g, ['<|tool_call|>', '<function_call>'], markup => {
	const calls: TextToolCall[] = [];
	let rest = markup;
	while (true) {
		const tag = GRANITE_TAG.exec(rest);
		if (!tag) {
			break;
		}
		const found = jsonCallsFrom(rest, tag.index + tag[0].length);
		if (!found) {
			return undefined;
		}
		calls.push(...found.calls);
		rest = found.rest;
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest };
});

// ---------- gpt-oss (harmony): a message to `functions.name` whose body is JSON ----------

const HARMONY_CALL = /to=functions\.([\w.-]+)/g;
const HARMONY_HEADER = /^[\s\w]*$/;
const HARMONY_TOKEN = /<\|(?:start|end|message|channel|constrain|call|return)\|>/g;

const HARMONY = opened(
	'harmony',
	/(?:<\|start\|>\s*assistant\s*)?(?:(?:<\|channel\|>\s*)?(?:commentary|analysis|final)\s+)?to=functions\./g,
	[
		'<|start|>assistant to=functions.', '<|start|>assistant<|channel|>commentary to=functions.',
		'<|channel|>commentary to=functions.', 'to=functions.',
	],
	markup => {
		const calls: TextToolCall[] = [];
		let end = 0;
		for (const call of markup.matchAll(HARMONY_CALL)) {
			if (call.index < end) {
				continue;
			}
			const recipientEnd = call.index + call[0].length;
			const body = markup.indexOf('{', recipientEnd);
			if (body < 0) {
				return undefined;
			}
			// Between the recipient and the body only the header may stand:
			// The channel, `json`, the constrain and message tokens
			const header = markup.slice(recipientEnd, body).replace(HARMONY_TOKEN, ' ');
			if (!HARMONY_HEADER.test(header)) {
				return undefined;
			}
			const json = jsonValueAt(markup, body);
			if (!json || !isJsonObject(json.value)) {
				return undefined;
			}
			calls.push({ name: call[1], arguments: json.value });
			end = json.end;
		}
		if (calls.length === 0) {
			return undefined;
		}
		return { calls, rest: markup.slice(end).replace(HARMONY_TOKEN, '') };
	},
);

// ---------- Gemma 4: `<|tool_call>call:name{key:value,…}<tool_call|>` with strings between `<|"|>` ----------

const GEMMA_BLOCK = /<\|tool_call>(.*?)(?:<tool_call\|>|$)/gs;
const GEMMA_HEAD = /^\s*(?:call)?:([\w.-]+)\s*(?=\{)/;
const GEMMA_QUOTE = '<|"|>';

/** Gemma's argument syntax: unquoted keys, strings between `<|"|>`, bare values typed by schema */
class GemmaValues {
	constructor(private readonly text: string, private at: number) { }

	/** The value at the reading point; undefined when it does not read */
	value(schema: TextToolCallSchema | undefined): JsonValue | undefined {
		this.skip();
		const text = this.text;
		if (text.startsWith(GEMMA_QUOTE, this.at)) {
			const found = text.indexOf(GEMMA_QUOTE, this.at + GEMMA_QUOTE.length);
			const close = found < 0 ? text.length : found;
			const string = text.slice(this.at + GEMMA_QUOTE.length, close);
			this.at = Math.min(text.length, close + GEMMA_QUOTE.length);
			return string;
		}
		if (text.startsWith('{', this.at)) {
			this.at++;
			const properties = propertiesOf(schema);
			const members: JsonObject = {};
			while (true) {
				this.skip();
				if (this.at >= text.length) {
					return undefined;
				}
				if (text[this.at] === '}') {
					this.at++;
					break;
				}
				const colon = text.indexOf(':', this.at);
				if (colon < 0) {
					return undefined;
				}
				const key = removeSurrounding(removeSurrounding(text.slice(this.at, colon).trim(), '"'), GEMMA_QUOTE);
				this.at = colon + 1;
				const value = this.value(memberSchema(properties, key));
				if (value === undefined) {
					return undefined;
				}
				setMember(members, key, value);
				this.skipComma();
			}
			return members;
		}
		if (text.startsWith('[', this.at)) {
			this.at++;
			const items = asSchema(schema?.items);
			const values: JsonValue[] = [];
			while (true) {
				this.skip();
				if (this.at >= text.length) {
					return undefined;
				}
				if (text[this.at] === ']') {
					this.at++;
					break;
				}
				const value = this.value(items);
				if (value === undefined) {
					return undefined;
				}
				values.push(value);
				this.skipComma();
			}
			return values;
		}
		const start = this.at;
		while (this.at < text.length && !',}]'.includes(text[this.at])) {
			this.at++;
		}
		return coerce(text.slice(start, this.at).trim(), schema);
	}

	private skipComma(): void {
		this.skip();
		if (this.text[this.at] === ',') {
			this.at++;
		}
	}

	private skip(): void {
		while (this.at < this.text.length && isWhitespace(this.text[this.at])) {
			this.at++;
		}
	}
}

const GEMMA = opened('gemma', /<\|tool_call>/g, ['<|tool_call>'], (markup, schemas) => {
	const calls: TextToolCall[] = [];
	for (const block of markup.matchAll(GEMMA_BLOCK)) {
		const body = block[1];
		const head = GEMMA_HEAD.exec(body);
		if (!head) {
			return undefined;
		}
		const name = head[1];
		const parsed = new GemmaValues(body, head.index + head[0].length).value(schemas(name));
		if (parsed === undefined || !isJsonObject(parsed)) {
			return undefined;
		}
		calls.push({ name, arguments: parsed });
	}
	if (calls.length === 0) {
		return undefined;
	}
	return { calls, rest: markup.replace(GEMMA_BLOCK, '') };
});

// ---------- Llama 4 and the pythonic templates: the answer is a Python list of calls with keyword arguments ----------

/** `[name(key=literal, …), …]`: strings, numbers, True/False/None (and their JSON spellings), lists, dicts, tuples */
class PythonCalls {
	constructor(private readonly text: string, private at: number) { }

	get end(): number {
		return this.at;
	}

	calls(): TextToolCall[] | undefined {
		if (!this.eat('[')) {
			return undefined;
		}
		const calls: TextToolCall[] = [];
		while (true) {
			this.skip();
			if (this.eat(']')) {
				return calls.length > 0 ? calls : undefined;
			}
			const name = this.identifier(true);
			if (name === undefined || !this.eat('(')) {
				return undefined;
			}
			const args: JsonObject = {};
			while (true) {
				this.skip();
				if (this.eat(')')) {
					break;
				}
				const key = this.identifier(false);
				if (key === undefined || !this.eat('=')) {
					return undefined;
				}
				const value = this.literal();
				if (value === undefined) {
					return undefined;
				}
				setMember(args, key, value);
				this.eat(',');
			}
			calls.push({ name, arguments: args });
			this.eat(',');
		}
	}

	private literal(): JsonValue | undefined {
		this.skip();
		if (this.at >= this.text.length) {
			return undefined;
		}
		const c = this.text[this.at];
		if (c === '"' || c === '\'') {
			return this.string(c);
		}
		if (c === '[' || c === '(') {
			return this.sequence(c === '[' ? ']' : ')');
		}
		if (c === '{') {
			return this.dict();
		}
		const start = this.at;
		while (this.at < this.text.length && (isLetterOrDigit(this.text[this.at]) || '+-._'.includes(this.text[this.at]))) {
			this.at++;
		}
		const word = this.text.slice(start, this.at);
		switch (word) {
			case 'True': case 'true': return true;
			case 'False': case 'false': return false;
			case 'None': case 'null': return null;
			default: return parseInteger(word) ?? parseNumber(word);
		}
	}

	private string(quote: string): JsonValue | undefined {
		this.at++;
		let out = '';
		while (this.at < this.text.length && this.text[this.at] !== quote) {
			if (this.text[this.at] === '\\' && this.at + 1 < this.text.length) {
				this.at++;
				const escaped = this.text[this.at];
				out += escaped === 'n' ? '\n' : escaped === 't' ? '\t' : escaped === 'r' ? '\r' : escaped;
			} else {
				out += this.text[this.at];
			}
			this.at++;
		}
		return this.eat(quote) ? out : undefined;
	}

	private sequence(close: string): JsonValue | undefined {
		this.at++;
		const values: JsonValue[] = [];
		while (true) {
			this.skip();
			if (this.eat(close)) {
				return values;
			}
			const value = this.literal();
			if (value === undefined) {
				return undefined;
			}
			values.push(value);
			this.eat(',');
		}
	}

	private dict(): JsonValue | undefined {
		this.at++;
		const members: JsonObject = {};
		while (true) {
			this.skip();
			if (this.eat('}')) {
				return members;
			}
			const key = this.literal();
			if (typeof key !== 'string' || !this.eat(':')) {
				return undefined;
			}
			const value = this.literal();
			if (value === undefined) {
				return undefined;
			}
			setMember(members, key, value);
			this.eat(',');
		}
	}

	private identifier(dotted: boolean): string | undefined {
		this.skip();
		const start = this.at;
		while (this.at < this.text.length) {
			const c = this.text[this.at];
			if (!isLetterOrDigit(c) && c !== '_' && !(dotted && c === '.')) {
				break;
			}
			this.at++;
		}
		const name = this.text.slice(start, this.at);
		return name.length > 0 && !/\p{Nd}/u.test(name[0]) ? name : undefined;
	}

	private skip(): void {
		while (this.at < this.text.length && isWhitespace(this.text[this.at])) {
			this.at++;
		}
	}

	private eat(c: string): boolean {
		this.skip();
		if (this.text[this.at] === c) {
			this.at++;
			return true;
		}
		return false;
	}
}

const PYTHONIC = wholeAnswer('pythonic', /^\s*(?:<\|python_start\|>\s*)?\[\s*[A-Za-z_][\w.]*\s*\(/, markup => {
	const reader = new PythonCalls(markup, markup.indexOf('['));
	const calls = reader.calls();
	return calls ? { calls, rest: markup.slice(reader.end).replaceAll('<|python_end|>', '') } : undefined;
});

/**
 * Every form, in the order a shared opener is tried: MiniMax M3 before `<tool_call>` (its opener contains it),
 * the JSON body of `<tool_call>` before the XML one and GLM, the marked invoke forms before the bare one
 */
export const TEXT_TOOL_CALL_FORMATS: readonly TextToolCallFormat[] = [
	MINIMAX_M3, DSML, MINIMAX_M2, INVOKE_XML, DEEPSEEK_V3, HERMES, QWEN_XML, GLM, KIMI_K2, KIMI_K3, MISTRAL, LLAMA,
	GRANITE, HARMONY, GEMMA, JSON_ANSWER, PYTHONIC,
];
