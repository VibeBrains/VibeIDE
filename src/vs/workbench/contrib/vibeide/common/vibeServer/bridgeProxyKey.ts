/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Identity of a dev-server the bridge proxy sits in front of.
 *
 * A multi-app workspace runs several dev-servers at once, so the proxy pool needs to tell them
 * apart. Pure and separate from the pool so the tricky part — what counts as "the same server" —
 * can be tested without binding a port.
 */

/**
 * Reduces a dev-server url to the key its proxy is stored under: scheme, host and port, with the
 * path dropped (two pages of one app are one app).
 *
 * **`localhost` and `127.0.0.1` are deliberately NOT merged.** They look interchangeable and are
 * not: `localhost` resolves to `::1` on macOS, so a server bound to one is unreachable on the
 * other. Treating them as one key would hand out a proxy pointing at an address that never answers
 * — the exact confusion that already cost us a debugging session (knowledge: designReview.md).
 *
 * An unparseable url returns its trimmed lowercase self: a bad key is still a stable key, so the
 * caller gets one proxy per bad url rather than a collision between two different ones.
 */
export function bridgeProxyKey(upstreamUrl: string): string {
	const raw = upstreamUrl.trim();
	try {
		const url = new URL(raw);
		// `url.port` is empty for a default port, and the origin already spells that out.
		return url.origin.toLowerCase();
	} catch {
		return raw.toLowerCase();
	}
}
