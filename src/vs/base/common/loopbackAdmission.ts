/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Who is allowed to talk to a local HTTP listener.
 *
 * VibeIDE opens more than one such listener (the incoming agent API, the MCP gateway), and each of
 * them, if reached, executes something on the owner's machine. The rules below are the same for all
 * of them, so they live in one place: two implementations of "is this request local" drift, and the
 * one that drifts is the one nobody tested.
 *
 * Binding to `127.0.0.1` is necessary but NOT sufficient. A web page the owner visits can point its
 * own domain at `127.0.0.1` (DNS rebinding) and have the browser send requests to a local port with
 * the site's own credentials — the socket really is local, and only the `Host` header betrays that
 * the request was addressed to `evil.example.com`.
 */

/** Hostnames that mean "this machine" and are therefore safe in a `Host` header. */
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]', '::1']);

/**
 * Is the `Host` header addressed to this machine by a loopback name?
 *
 * The port is ignored — it is not a security property, and requiring an exact match would break
 * every listener that binds port 0 and takes whatever it is given.
 */
export function isLoopbackHost(hostHeader: string | undefined): boolean {
	if (!hostHeader) { return false; }
	const host = hostHeader.trim().toLowerCase();
	// IPv6 literals carry their own brackets: `[::1]:1234`. A bare `::1` violates RFC 7230, which
	// requires the brackets, but it is still unambiguously this machine and cannot be made to point
	// at someone else's domain — so it is recognised rather than refused on a formality. It is
	// detected by having more than one colon, which no `host:port` pair does.
	const withoutPort = host.startsWith('[')
		? host.slice(0, host.indexOf(']') + 1)
		: host.indexOf(':') !== host.lastIndexOf(':')
			? host
			: host.split(':')[0];
	return LOOPBACK_HOSTS.has(withoutPort);
}

/**
 * Is the socket peer this machine?
 *
 * IPv4-mapped IPv6 (`::ffff:127.0.0.1`) is what a dual-stack listener reports for an ordinary IPv4
 * loopback client, so rejecting it would refuse legitimate local callers.
 */
export function isRemoteLoopback(remoteAddress: string | undefined): boolean {
	if (!remoteAddress) { return false; }
	const addr = remoteAddress.toLowerCase();
	return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1' || addr.startsWith('127.');
}

/**
 * Compare two secrets without leaking their contents through timing.
 *
 * Length is compared first and non-secretly on purpose: the length of a token we generate ourselves
 * is not the secret, and folding it into the loop would either short-circuit (leaking position) or
 * index out of bounds.
 */
export function secretEquals(a: string, b: string): boolean {
	if (a.length !== b.length) { return false; }
	let diff = 0;
	for (let i = 0; i < a.length; i++) {
		diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
	}
	return diff === 0;
}
