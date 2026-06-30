/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Minimal `.vibe/.env` parser — a local secrets source for `apiKeyEnv` in `.vibe/providers.json`
 * (so users don't have to set an OS environment variable + restart). Read by the browser
 * dynamic-providers service; the matched value is merged transiently into the request transport.
 *
 * Pure (no I/O) → unit-testable. Format (deliberately tiny, dotenv-compatible subset):
 *   - `KEY=VALUE` per line; `KEY` matches `[A-Za-z_][A-Za-z0-9_]*`.
 *   - Blank lines and `#`-comment lines ignored.
 *   - Optional `export ` prefix tolerated.
 *   - Surrounding matching single/double quotes are stripped from the value.
 *   - No interpolation, no multiline values — keep it boring and predictable.
 *   - Later duplicate keys win.
 */

export function parseEnvFile(raw: string | undefined | null): Record<string, string> {
	const out: Record<string, string> = {};
	if (!raw) { return out; }

	for (const rawLine of raw.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith('#')) { continue; }

		const body = line.startsWith('export ') ? line.slice('export '.length).trim() : line;
		const eq = body.indexOf('=');
		if (eq <= 0) { continue; } // no `=`, or empty key

		const key = body.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) { continue; } // skip malformed keys

		let value = body.slice(eq + 1).trim();
		if (value.length >= 2) {
			const first = value[0];
			const last = value[value.length - 1];
			if ((first === '"' && last === '"') || (first === '\'' && last === '\'')) {
				value = value.slice(1, -1);
			}
		}
		out[key] = value;
	}

	return out;
}
