/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * What actually failed when a request never reached the provider.
 *
 * Clients say «Connection error» or «Cannot connect to API» and put the real undici/Node error a few
 * `cause` links deeper — the one place that tells DNS from TLS interception from a refused port. Without
 * unwrapping, every network failure reads the same, and «Ollama is not running» looks exactly like «the
 * corporate proxy rewrote the certificate».
 */

/** A node of an `Error.cause` chain; every field optional, read defensively. */
interface NodeErrorLike {
	readonly name?: string;
	readonly message?: string;
	readonly code?: string;
	readonly errno?: number;
	readonly syscall?: string;
	readonly address?: string;
	readonly port?: number;
	readonly hostname?: string;
	readonly cause?: unknown;
}

const asNodeErrorLike = (value: unknown): NodeErrorLike | undefined => (typeof value === 'object' && value !== null ? value as NodeErrorLike : undefined);

/** Deeper than this the chain is not a network error but something wrapping itself. */
const MAX_CAUSE_DEPTH = 6;

/**
 * The error message with the network facts found down its cause chain, e.g.
 * `Cannot connect to API: fetch failed [code=ECONNREFUSED syscall=connect host=127.0.0.1:11434]`,
 * or undefined when the chain carries no network error code — then it is not a connection failure.
 */
export function describeConnectionError(error: unknown): string | undefined {
	const facts: string[] = [];
	let host: string | undefined;
	let port: number | undefined;
	let hasCode = false;
	let current = asNodeErrorLike(error);
	for (let depth = 0; current && depth < MAX_CAUSE_DEPTH; depth++) {
		if (current.code && !facts.some(fact => fact.startsWith('code='))) {
			facts.push(`code=${current.code}`);
			hasCode = true;
		}
		if (current.errno !== undefined && !facts.some(fact => fact.startsWith('errno='))) { facts.push(`errno=${current.errno}`); }
		if (current.syscall && !facts.some(fact => fact.startsWith('syscall='))) { facts.push(`syscall=${current.syscall}`); }
		if (current.address && !facts.some(fact => fact.startsWith('address='))) { facts.push(`address=${current.address}`); }
		if (typeof current.port === 'number' && port === undefined) { port = current.port; }
		if (typeof current.hostname === 'string' && !host) { host = current.hostname; }
		current = asNodeErrorLike(current.cause);
	}
	if (!hasCode) {
		return undefined;
	}
	if (host || port !== undefined) {
		facts.push(`host=${host ?? '?'}${port !== undefined ? `:${port}` : ''}`);
	}
	const message = asNodeErrorLike(error)?.message || String(error);
	return `${message} [${facts.join(' ')}]`;
}
