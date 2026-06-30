/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `VibeMCPOAuthService` — PKCE flow contract (pure helper)
 * (roadmap §"Real-impl tail / Phase 3b — `VibeMCPOAuthService` реальный
 * PKCE flow (security gap для GitHub/Linear/Notion)" + §"K.2 secret hygiene").
 *
 * RFC 7636 — Proof Key for Code Exchange. Pure helpers — `vscode`-free —
 * companion to the real OAuth dance which lives in `browser/`. This module
 * provides:
 *   - state validation (returned `state` matches the one we sent)
 *   - PKCE pair builder shape (caller injects randomness + SHA-256)
 *   - authorisation-URL builder
 *   - token-response decoder + refresh decision
 *
 * The actual `crypto` calls (random bytes, SHA-256) come from the host
 * runtime — the helpers take a `pkceRandomness` injection so unit tests
 * use deterministic fixtures.
 */

const PKCE_CODE_VERIFIER_PATTERN = /^[A-Za-z0-9._~-]{43,128}$/;
const PKCE_STATE_PATTERN = /^[A-Za-z0-9._~-]{16,128}$/;

export interface PkcePair {
	readonly codeVerifier: string;
	readonly codeChallenge: string;
	readonly codeChallengeMethod: 'S256';
}

export interface PkceRandomness {
	/** RFC 7636 — high-entropy code_verifier; caller supplies via crypto.randomBytes. */
	readonly codeVerifier: string;
	/** Base64url-encoded SHA-256 of `codeVerifier`. */
	readonly codeChallenge: string;
}

export type PkceBuildResult =
	| { readonly ok: true; readonly pair: PkcePair }
	| { readonly ok: false; readonly reason: 'verifier-malformed' | 'challenge-malformed' };

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]+$/;

/**
 * Validate a caller-supplied PKCE pair. RFC 7636 §4.1 says verifier is
 * 43-128 chars, alphanumeric + `-._~`. The challenge is base64url of SHA-256
 * — we accept any base64url string of at least 43 chars (28 bytes
 * un-padded), which is the SHA-256 length.
 */
export function buildPkcePair(randomness: PkceRandomness): PkceBuildResult {
	if (typeof randomness.codeVerifier !== 'string' || !PKCE_CODE_VERIFIER_PATTERN.test(randomness.codeVerifier)) {
		return { ok: false, reason: 'verifier-malformed' };
	}
	if (typeof randomness.codeChallenge !== 'string' || randomness.codeChallenge.length < 43 || !BASE64URL_PATTERN.test(randomness.codeChallenge)) {
		return { ok: false, reason: 'challenge-malformed' };
	}
	return {
		ok: true,
		pair: {
			codeVerifier: randomness.codeVerifier,
			codeChallenge: randomness.codeChallenge,
			codeChallengeMethod: 'S256',
		},
	};
}

export interface AuthUrlInput {
	readonly authorizationEndpoint: string;
	readonly clientId: string;
	readonly redirectUri: string;
	readonly scope?: string;
	readonly state: string;
	readonly pair: PkcePair;
}

export type BuildAuthUrlResult =
	| { readonly ok: true; readonly url: string }
	| { readonly ok: false; readonly reason: 'endpoint-not-https' | 'endpoint-malformed' | 'client-id-empty' | 'redirect-uri-empty' | 'state-malformed' };

/**
 * Build the authorisation URL. RFC 6749 §4.1.1 with PKCE extension.
 * Refuses non-HTTPS authorisation endpoints (callers can special-case
 * `localhost` for testing — helper does not).
 */
export function buildAuthorizationUrl(input: AuthUrlInput): BuildAuthUrlResult {
	if (typeof input.clientId !== 'string' || input.clientId.length === 0) {
		return { ok: false, reason: 'client-id-empty' };
	}
	if (typeof input.redirectUri !== 'string' || input.redirectUri.length === 0) {
		return { ok: false, reason: 'redirect-uri-empty' };
	}
	if (typeof input.state !== 'string' || !PKCE_STATE_PATTERN.test(input.state)) {
		return { ok: false, reason: 'state-malformed' };
	}
	let parsed: URL;
	try {
		parsed = new URL(input.authorizationEndpoint);
	} catch {
		return { ok: false, reason: 'endpoint-malformed' };
	}
	if (parsed.protocol !== 'https:') {
		return { ok: false, reason: 'endpoint-not-https' };
	}
	parsed.searchParams.set('response_type', 'code');
	parsed.searchParams.set('client_id', input.clientId);
	parsed.searchParams.set('redirect_uri', input.redirectUri);
	parsed.searchParams.set('state', input.state);
	parsed.searchParams.set('code_challenge', input.pair.codeChallenge);
	parsed.searchParams.set('code_challenge_method', input.pair.codeChallengeMethod);
	if (input.scope !== undefined && input.scope.length > 0) {
		parsed.searchParams.set('scope', input.scope);
	}
	return { ok: true, url: parsed.toString() };
}

export type CallbackVerdict =
	| { readonly kind: 'ok'; readonly code: string }
	| { readonly kind: 'state-mismatch' }
	| { readonly kind: 'provider-error'; readonly error: string; readonly description?: string }
	| { readonly kind: 'missing-code' };

/**
 * Verify the OAuth provider's callback redirect. Pure: caller has parsed the
 * URL `searchParams` into a flat map.
 *
 * Refuses on `state` mismatch BEFORE looking at any other param — CSRF
 * defence comes first.
 */
export function verifyOAuthCallback(params: ReadonlyMap<string, string>, expectedState: string): CallbackVerdict {
	const returnedState = params.get('state');
	if (returnedState !== expectedState) {
		return { kind: 'state-mismatch' };
	}
	const error = params.get('error');
	if (typeof error === 'string' && error.length > 0) {
		const description = params.get('error_description');
		return {
			kind: 'provider-error',
			error,
			...(description ? { description } : {}),
		};
	}
	const code = params.get('code');
	if (typeof code !== 'string' || code.length === 0) {
		return { kind: 'missing-code' };
	}
	return { kind: 'ok', code };
}

export interface OAuthTokenResponse {
	readonly accessToken: string;
	readonly tokenType: string;
	readonly expiresInSeconds?: number;
	readonly refreshToken?: string;
	readonly scope?: string;
}

export type DecodeTokenResult =
	| { readonly ok: true; readonly value: OAuthTokenResponse }
	| { readonly ok: false; readonly reason: string };

/**
 * Decode the `/token` endpoint response. RFC 6749 §5.1. Refuses any shape
 * missing `access_token` or with non-string `token_type`.
 */
export function decodeTokenResponse(raw: unknown): DecodeTokenResult {
	if (!raw || typeof raw !== 'object') { return { ok: false, reason: 'not-an-object' }; }
	const o = raw as Record<string, unknown>;
	if (typeof o.access_token !== 'string' || o.access_token.length === 0) {
		return { ok: false, reason: 'access_token-missing' };
	}
	if (typeof o.token_type !== 'string' || o.token_type.length === 0) {
		return { ok: false, reason: 'token_type-missing' };
	}
	const value: OAuthTokenResponse = {
		accessToken: o.access_token,
		tokenType: o.token_type,
	};
	if (typeof o.expires_in === 'number' && Number.isFinite(o.expires_in) && o.expires_in > 0) {
		(value as { expiresInSeconds?: number }).expiresInSeconds = Math.floor(o.expires_in);
	}
	if (typeof o.refresh_token === 'string' && o.refresh_token.length > 0) {
		(value as { refreshToken?: string }).refreshToken = o.refresh_token;
	}
	if (typeof o.scope === 'string' && o.scope.length > 0) {
		(value as { scope?: string }).scope = o.scope;
	}
	return { ok: true, value };
}

export type RefreshDecision =
	| { readonly kind: 'fresh' }
	| { readonly kind: 'should-refresh'; readonly reason: 'expires-soon' | 'no-expires-known' }
	| { readonly kind: 'expired' }
	| { readonly kind: 'no-refresh-token-available' };

export interface RefreshDecisionInput {
	readonly tokenIssuedAtMs: number;
	readonly token: OAuthTokenResponse;
	readonly nowMs: number;
	/** How early before `expires_in` to start refreshing — default 60s. */
	readonly refreshLeadMs?: number;
}

/**
 * Decide whether the access token needs refresh. Pure — time injection.
 *
 *   - no `expires_in` recorded             → 'should-refresh: no-expires-known'
 *     (provider didn't give us a TTL — refresh proactively to be safe)
 *   - expired (now > issued + ttl)         → 'expired'
 *   - within `refreshLeadMs` of expiry     → 'should-refresh: expires-soon'
 *   - otherwise                            → 'fresh'
 *   - if expired/expires-soon and no `refresh_token` → 'no-refresh-token-available'
 */
export function decideTokenRefresh(input: RefreshDecisionInput): RefreshDecision {
	const lead = typeof input.refreshLeadMs === 'number' && Number.isFinite(input.refreshLeadMs) && input.refreshLeadMs >= 0
		? input.refreshLeadMs
		: 60_000;
	if (input.token.expiresInSeconds === undefined) {
		return refreshOrNoToken(input.token, 'no-expires-known');
	}
	const expiresAtMs = input.tokenIssuedAtMs + input.token.expiresInSeconds * 1000;
	if (input.nowMs >= expiresAtMs) {
		return refreshOrNoToken(input.token, 'expired');
	}
	if (input.nowMs + lead >= expiresAtMs) {
		return refreshOrNoToken(input.token, 'expires-soon');
	}
	return { kind: 'fresh' };
}

function refreshOrNoToken(token: OAuthTokenResponse, reason: 'expires-soon' | 'no-expires-known' | 'expired'): RefreshDecision {
	if (typeof token.refreshToken !== 'string' || token.refreshToken.length === 0) {
		if (reason === 'expired') { return { kind: 'expired' }; }
		return { kind: 'no-refresh-token-available' };
	}
	if (reason === 'expired') { return { kind: 'expired' }; }
	return { kind: 'should-refresh', reason };
}
