/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import type { MCPConfigFileEntryJSON } from './mcpServiceTypes.js';

/**
 * The MCP servers file of the VibeBrains family — one format for VibeIDE and VibeIDEA.
 *
 * Two places, the same format:
 * `~/.vibe/mcp.json` is the person's own servers, for every project
 * `<project>/.vibe/mcp.json` is the project's, and over a user server of the same name it wins
 *
 * WHY one file for both products: the same person keeps the same Jira, database and tracker servers in both IDEs.
 * Two files meant writing every server twice and finding out which copy had the stale token.
 *
 * The parser is tolerant and loud, as VibeIDEA's `McpServersFile.parse` is:
 * A broken entry is named and skipped, the others work
 * A server dropped in silence looks like a broken tool, not like a typo in the config
 * The cases both products must agree on live in the shared vectors (`testVectors/mcpServersFile.json` of the seeds)
 *
 * Pure: text in, entries and complaints out. No file system, no window.
 */

/** The file name in every `.vibe` folder */
export const MCP_FILE_NAME = 'mcp.json';

/** The family folder: `~/.vibe` for the person, `<project>/.vibe` for a project */
export const VIBE_FAMILY_DIR_NAME = '.vibe';

/** Suffix of the old per-product file once its servers have moved: never read again, kept so nothing is lost */
export const MCP_MIGRATED_SUFFIX = '.migrated';

/** Where a server entry was written */
export type McpLayerSource = 'user' | 'project';

/**
 * What is wrong with a file, by code and entry name rather than by phrase
 * The parser does not know the interface language: the phrase is built where it is shown ([describeMcpFileProblem])
 * The first four codes are VibeIDEA's own, so the vectors speak one language in both products
 */
export type McpFileProblemCode =
	| 'NOT_JSON'
	| 'NO_SECTION'
	| 'NOT_AN_OBJECT'
	| 'NO_COMMAND'
	| 'AMBIGUOUS';

export interface McpFileProblem {
	readonly problem: McpFileProblemCode;
	/** The entry the complaint is about; absent when it is about the whole file */
	readonly name?: string;
}

export interface ParsedMcpFile {
	readonly servers: Record<string, MCPConfigFileEntryJSON>;
	readonly problems: readonly McpFileProblem[];
}

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The root object of a file text, or nothing when the text is not a JSON object */
export function parseMcpRoot(text: string): JsonObject | undefined {
	try {
		const root: unknown = JSON.parse(text);
		return isJsonObject(root) ? root : undefined;
	} catch {
		return undefined;
	}
}

/**
 * The `mcpServers` object of a file, entries untouched, or the reason there is none.
 * Shared by the parser and the migration: the latter moves entries as they were written, unknown fields included
 */
export function readMcpServersSection(text: string): { readonly kind: 'section'; readonly root: JsonObject; readonly section: JsonObject } | { readonly kind: 'problem'; readonly problem: 'NOT_JSON' | 'NO_SECTION' } {
	const root = parseMcpRoot(text);
	if (!root) {
		return { kind: 'problem', problem: 'NOT_JSON' };
	}
	const section = root['mcpServers'];
	if (!isJsonObject(section)) {
		return { kind: 'problem', problem: 'NO_SECTION' };
	}
	return { kind: 'section', root, section };
}

/** A scalar as text, the way VibeIDEA reads it: `5` and `true` are the strings «5» and «true», `null` is nothing */
function scalarText(value: unknown): string | undefined {
	if (typeof value === 'string') {
		return value;
	}
	return typeof value === 'number' || typeof value === 'boolean' ? String(value) : undefined;
}

function normalizedArgs(value: unknown): string[] | undefined {
	if (!Array.isArray(value)) {
		return undefined;
	}
	return value.map(scalarText).filter((item): item is string => item !== undefined);
}

function normalizedEnv(value: unknown): Record<string, string> | undefined {
	if (!isJsonObject(value)) {
		return undefined;
	}
	const env: Record<string, string> = {};
	for (const [key, item] of Object.entries(value)) {
		const text = scalarText(item);
		if (text !== undefined) {
			env[key] = text;
		}
	}
	return env;
}

/** `true` and `"true"` switch an entry off; anything else leaves it on, as VibeIDEA reads the field */
function isDisabled(value: unknown): boolean {
	return scalarText(value) === 'true';
}

/**
 * Entries of a file text, tolerant and loud.
 *
 * An entry with `command` is a program to run; an entry with `url` is a server to connect to.
 * Both at once is a complaint and the entry is skipped: VibeIDE would connect to the address and VibeIDEA would
 * run the program, and one record must not mean two different things in two products.
 */
export function parseMcpServersFile(text: string): ParsedMcpFile {
	const read = readMcpServersSection(text);
	if (read.kind === 'problem') {
		return { servers: {}, problems: [{ problem: read.problem }] };
	}
	const servers: Record<string, MCPConfigFileEntryJSON> = {};
	const problems: McpFileProblem[] = [];
	for (const [name, body] of Object.entries(read.section)) {
		if (!isJsonObject(body)) {
			problems.push({ problem: 'NOT_AN_OBJECT', name });
			continue;
		}
		const command = typeof body['command'] === 'string' ? body['command'].trim() : '';
		const url = typeof body['url'] === 'string' ? body['url'].trim() : '';
		if (command && url) {
			problems.push({ problem: 'AMBIGUOUS', name });
			continue;
		}
		if (!command && !url) {
			// Named on purpose: with five servers in the file the person must learn which one has nothing to start
			problems.push({ problem: 'NO_COMMAND', name });
			continue;
		}
		const entry: JsonObject = { ...body };
		if (command) {
			entry['command'] = command;
			setOrDrop(entry, 'args', normalizedArgs(body['args']));
			setOrDrop(entry, 'env', normalizedEnv(body['env']));
		}
		setOrDrop(entry, 'disabled', isDisabled(body['disabled']) ? true : undefined);
		servers[name] = entry as MCPConfigFileEntryJSON;
	}
	return { servers, problems };
}

function setOrDrop(entry: JsonObject, key: string, value: unknown): void {
	if (value === undefined) {
		delete entry[key];
	} else {
		entry[key] = value;
	}
}

/** One layer of the picture: the servers of one file and where the file lives */
export interface McpLayer {
	readonly source: McpLayerSource;
	readonly servers: Readonly<Record<string, MCPConfigFileEntryJSON>>;
}

export interface MergedMcpLayers {
	readonly servers: Record<string, MCPConfigFileEntryJSON>;
	readonly sourceOfName: Record<string, McpLayerSource>;
	/** Names a stronger layer wrote over a weaker one, so the person can be told whose entry runs */
	readonly overridden: readonly string[];
}

/**
 * Layers folded weakest first. An entry of a stronger layer replaces the weaker one WHOLE, not field by field:
 * a `command` of one server with the `args` of another would be a server nobody wrote.
 * Names compare exactly, as the file spells them.
 */
export function mergeMcpLayers(layers: readonly McpLayer[]): MergedMcpLayers {
	const servers: Record<string, MCPConfigFileEntryJSON> = {};
	const sourceOfName: Record<string, McpLayerSource> = {};
	const overridden = new Set<string>();
	for (const layer of layers) {
		for (const [name, entry] of Object.entries(layer.servers)) {
			if (Object.hasOwn(servers, name)) {
				overridden.add(name);
			}
			servers[name] = entry;
			sourceOfName[name] = layer.source;
		}
	}
	return { servers, sourceOfName, overridden: [...overridden] };
}

/** JSON with sorted keys, so two entries written in another order are still the same entry */
function canonicalJson(value: unknown): string {
	if (Array.isArray(value)) {
		return `[${value.map(canonicalJson).join(',')}]`;
	}
	if (isJsonObject(value)) {
		return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
	}
	return JSON.stringify(value) ?? 'null';
}

/**
 * What moving the servers of the old per-product file into the shared one will do.
 *
 * By name, never by content: an entry already in the shared file stays as the person has it there.
 * The same entry is nothing to move; a different one under the same name is a conflict, reported and not overwritten.
 */
export interface McpMigrationPlan {
	/** The shared file as it will be written: its own keys, its own servers, then the moved ones */
	readonly root: JsonObject;
	readonly moved: readonly string[];
	/** Already in the shared file, byte for byte the same entry */
	readonly same: readonly string[];
	/** In both files under one name with different entries: the shared file's entry stays */
	readonly conflicts: readonly string[];
}

export function planMcpMigration(legacyServers: Readonly<JsonObject>, sharedRoot: Readonly<JsonObject> | undefined): McpMigrationPlan {
	const existing = sharedRoot?.['mcpServers'];
	const sharedSection: JsonObject = isJsonObject(existing) ? existing : {};
	const section: JsonObject = { ...sharedSection };
	const moved: string[] = [];
	const same: string[] = [];
	const conflicts: string[] = [];
	for (const [name, entry] of Object.entries(legacyServers)) {
		if (!Object.hasOwn(sharedSection, name)) {
			section[name] = entry;
			moved.push(name);
		} else if (canonicalJson(sharedSection[name]) === canonicalJson(entry)) {
			same.push(name);
		} else {
			conflicts.push(name);
		}
	}
	return { root: { ...(sharedRoot ?? {}), mcpServers: section }, moved, same, conflicts };
}

/** The phrase for a complaint about a file, in the interface language */
export function describeMcpFileProblem(problem: McpFileProblem): string {
	const name = problem.name ?? '';
	switch (problem.problem) {
		case 'NOT_JSON': return localize('vibeide.mcp.file.notJson', "файл не разобрался как JSON");
		case 'NO_SECTION': return localize('vibeide.mcp.file.noSection', "в файле нет объекта mcpServers");
		case 'NOT_AN_OBJECT': return localize('vibeide.mcp.file.notAnObject', "«{0}»: запись должна быть объектом", name);
		case 'NO_COMMAND': return localize('vibeide.mcp.file.noCommand', "«{0}»: не указан ни command, ни url", name);
		case 'AMBIGUOUS': return localize('vibeide.mcp.file.ambiguous', "«{0}»: указаны и command, и url — оставьте одно, иначе два продукта запустят разное", name);
	}
}
