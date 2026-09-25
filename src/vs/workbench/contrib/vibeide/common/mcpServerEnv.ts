/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { CRITICAL_ENV_OVERRIDES } from './vibeConfigGuard.js';

/**
 * How an MCP server entry's `env` and `headers` reach the server.
 *
 * WHY the entry now wins over the IDE environment: the merge used to lay `process.env` on top of the
 * entry, so a variable the IDE already had could not be set from `mcp.json` at all — a key exported
 * in the shell silently beat the one written for this server. That order came in with the first
 * import of the code, with no reason recorded, and every other MCP client does the opposite.
 *
 * WHY a few variables never come from the entry: that accidental order was also the only thing that
 * kept a cloned config from replacing `PATH` or preloading a library into the server process. The
 * guard calls those overrides critical, but in its default `warn` mode it only warns. With the entry
 * winning, those names are dropped here in every mode — the same list the guard reports, not a copy.
 * Names compare without case: on Windows `Path` and `PATH` are one variable.
 *
 * Pure: environments in, environment out.
 */

export interface MergedServerEnv {
	readonly env: Record<string, string>;
	/** Entry variables that were not applied because they are on the critical list. */
	readonly ignored: readonly string[];
}

export function mergeServerEnv(processEnv: Readonly<Record<string, string | undefined>>, entryEnv: Readonly<Record<string, string>> | undefined): MergedServerEnv {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(processEnv)) {
		if (value !== undefined) {
			env[key] = value;
		}
	}
	const ignored: string[] = [];
	for (const [key, value] of Object.entries(entryEnv ?? {})) {
		if (typeof value !== 'string') {
			continue;
		}
		if (CRITICAL_ENV_OVERRIDES.has(key.toUpperCase())) {
			ignored.push(key);
			continue;
		}
		env[key] = value;
	}
	return { env, ignored };
}

/**
 * The `requestInit` a transport needs for the entry's headers, or nothing when there are none.
 *
 * WHY: the headers were accepted by the format and never sent — both SDK transports read them from
 * `requestInit`, and SSE applies them to the event stream as well as to the posted messages
 * (`_commonHeaders` in the SDK), so one option covers every path.
 */
export function transportRequestInit(headers: Readonly<Record<string, string>> | undefined): { requestInit?: RequestInit } {
	const clean = Object.entries(headers ?? {}).filter(([, value]) => typeof value === 'string');
	return clean.length > 0 ? { requestInit: { headers: Object.fromEntries(clean) } } : {};
}

/**
 * The headers a `headersHelper` printed: a JSON object of strings and nothing else
 * `undefined` for anything else — the output may carry a token, so it is never echoed into an error or a log
 */
export function helperHeadersOf(stdout: string): Record<string, string> | undefined {
	let parsed: unknown;
	try {
		parsed = JSON.parse(stdout);
	} catch {
		return undefined;
	}
	if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
		return undefined;
	}
	const headers: Record<string, string> = {};
	for (const [name, value] of Object.entries(parsed)) {
		if (typeof value !== 'string') {
			return undefined;
		}
		headers[name] = value;
	}
	return Object.keys(headers).length > 0 ? headers : undefined;
}

/**
 * What a 401 from a server whose header comes from a helper means: the token was revoked or re-issued
 * For a team's memory the fix is in the VibeMemory cabinet, not in the server — said so, instead of a bare status
 */
export function describeUnauthorizedHelper(serverName: string, error: unknown): string | undefined {
	const text = error instanceof Error ? error.message : String(error ?? '');
	if (!/\b401\b|unauthori[sz]ed/i.test(text)) {
		return undefined;
	}
	return serverName.startsWith('vibememory-')
		? `Сервер памяти команды отклонил токен (401): его отозвали или выпустили заново. Возьмите в кабинете VibeMemory новый код для агента и выполните vibememory connect --agent vibeide.`
		: `Сервер «${serverName}» отклонил заголовок, выданный помощником headersHelper (401): токен устарел или отозван.`;
}
