/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// disable foreign import complaints
/* eslint-disable */
import { GoogleAuth } from 'google-auth-library';
/* eslint-enable */

/**
 * Module-level singleton-backed Google service account token.
 * Used for Google Vertex auth — token is short-lived (~1h), so we fetch
 * on each request rather than cache it.
 */
export const getGoogleApiKey = async (): Promise<string> => {
	const auth = new GoogleAuth({ scopes: `https://www.googleapis.com/auth/cloud-platform` });
	const key = await auth.getAccessToken();
	if (!key) { throw new Error(`Google API failed to generate a key.`); }
	return key;
};

/**
 * Validate that a string is safe to be used as an HTTP header value (Latin-1, codepoints <= 0xFF).
 * undici/fetch rejects bytes > 0xFF with a cryptic `Cannot convert argument to a ByteString` TypeError;
 * this helper throws a human-readable Error pinpointing the offending character instead.
 * Common cause: user copied the masked UI value (bullets) instead of the real API key.
 */
export const assertHttpHeaderSafe = (fieldLabel: string, value: string | undefined | null): void => {
	if (!value) { return; }
	for (let i = 0; i < value.length; i++) {
		const code = value.charCodeAt(i);
		if (code > 0xFF) {
			const ch = value[i];
			const hex = code.toString(16).toUpperCase().padStart(4, '0');
			throw new Error(
				`${fieldLabel} contains a non-Latin-1 character "${ch}" (U+${hex}) at position ${i}. ` +
				`HTTP headers only accept byte values 0-255. ` +
				`This usually means a masked UI value (e.g. "••••") was pasted instead of the real key. ` +
				`Re-enter the value without the mask.`
			);
		}
	}
};
