/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	buildPkcePair,
	buildAuthorizationUrl,
	verifyOAuthCallback,
	decodeTokenResponse,
	decideTokenRefresh,
} from '../../common/mcpOAuthPkceContract.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const VALID_VERIFIER = 'a'.repeat(43);
const VALID_CHALLENGE = 'b'.repeat(43);
const VALID_STATE = 'c'.repeat(16);

suite('MCP OAuth PKCE contract — pure helpers', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('buildPkcePair', () => {
		test('happy path', () => {
			const r = buildPkcePair({ codeVerifier: VALID_VERIFIER, codeChallenge: VALID_CHALLENGE });
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.pair.codeChallengeMethod, 'S256');
				assert.strictEqual(r.pair.codeVerifier, VALID_VERIFIER);
			}
		});

		test('verifier too short → reject', () => {
			const r = buildPkcePair({ codeVerifier: 'short', codeChallenge: VALID_CHALLENGE });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'verifier-malformed'); }
		});

		test('verifier too long → reject', () => {
			const r = buildPkcePair({ codeVerifier: 'a'.repeat(129), codeChallenge: VALID_CHALLENGE });
			assert.strictEqual(r.ok, false);
		});

		test('verifier with disallowed char → reject', () => {
			const r = buildPkcePair({ codeVerifier: 'a'.repeat(42) + '!', codeChallenge: VALID_CHALLENGE });
			assert.strictEqual(r.ok, false);
		});

		test('challenge non-base64url → reject', () => {
			const r = buildPkcePair({ codeVerifier: VALID_VERIFIER, codeChallenge: 'a'.repeat(42) + '!' });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'challenge-malformed'); }
		});

		test('challenge too short → reject', () => {
			const r = buildPkcePair({ codeVerifier: VALID_VERIFIER, codeChallenge: 'short' });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('buildAuthorizationUrl', () => {
		const pair = (buildPkcePair({ codeVerifier: VALID_VERIFIER, codeChallenge: VALID_CHALLENGE }) as { ok: true; pair: ReturnType<typeof buildPkcePair> extends { ok: true; pair: infer P } ? P : never }).pair;

		test('happy path with HTTPS endpoint', () => {
			const r = buildAuthorizationUrl({
				authorizationEndpoint: 'https://github.com/login/oauth/authorize',
				clientId: 'test-client',
				redirectUri: 'http://localhost:9999/callback',
				scope: 'repo',
				state: VALID_STATE,
				pair,
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				const u = new URL(r.url);
				assert.strictEqual(u.searchParams.get('response_type'), 'code');
				assert.strictEqual(u.searchParams.get('client_id'), 'test-client');
				assert.strictEqual(u.searchParams.get('code_challenge'), VALID_CHALLENGE);
				assert.strictEqual(u.searchParams.get('code_challenge_method'), 'S256');
				assert.strictEqual(u.searchParams.get('scope'), 'repo');
				assert.strictEqual(u.searchParams.get('state'), VALID_STATE);
			}
		});

		test('rejects http (non-https) endpoint', () => {
			const r = buildAuthorizationUrl({
				authorizationEndpoint: 'http://example.com/oauth',
				clientId: 'c', redirectUri: 'r', state: VALID_STATE, pair,
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'endpoint-not-https'); }
		});

		test('rejects empty client id', () => {
			const r = buildAuthorizationUrl({
				authorizationEndpoint: 'https://example.com/o',
				clientId: '', redirectUri: 'r', state: VALID_STATE, pair,
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'client-id-empty'); }
		});

		test('rejects malformed state', () => {
			const r = buildAuthorizationUrl({
				authorizationEndpoint: 'https://example.com/o',
				clientId: 'c', redirectUri: 'r', state: 'short', pair,
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'state-malformed'); }
		});

		test('omits scope when not set', () => {
			const r = buildAuthorizationUrl({
				authorizationEndpoint: 'https://example.com/o',
				clientId: 'c', redirectUri: 'r', state: VALID_STATE, pair,
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				const u = new URL(r.url);
				assert.strictEqual(u.searchParams.get('scope'), null);
			}
		});
	});

	suite('verifyOAuthCallback', () => {
		test('happy path → ok with code', () => {
			const r = verifyOAuthCallback(
				new Map([['state', VALID_STATE], ['code', 'auth-code-x']]),
				VALID_STATE,
			);
			assert.strictEqual(r.kind, 'ok');
			if (r.kind === 'ok') { assert.strictEqual(r.code, 'auth-code-x'); }
		});

		test('state mismatch → state-mismatch (CSRF defence)', () => {
			const r = verifyOAuthCallback(
				new Map([['state', 'attacker'], ['code', 'x']]),
				VALID_STATE,
			);
			assert.strictEqual(r.kind, 'state-mismatch');
		});

		test('provider error before code check', () => {
			const r = verifyOAuthCallback(
				new Map([['state', VALID_STATE], ['error', 'access_denied'], ['error_description', 'user said no']]),
				VALID_STATE,
			);
			assert.strictEqual(r.kind, 'provider-error');
			if (r.kind === 'provider-error') {
				assert.strictEqual(r.error, 'access_denied');
				assert.strictEqual(r.description, 'user said no');
			}
		});

		test('missing code with valid state → missing-code', () => {
			const r = verifyOAuthCallback(new Map([['state', VALID_STATE]]), VALID_STATE);
			assert.strictEqual(r.kind, 'missing-code');
		});

		test('state-mismatch wins over error param', () => {
			const r = verifyOAuthCallback(
				new Map([['state', 'wrong'], ['error', 'oops']]),
				VALID_STATE,
			);
			assert.strictEqual(r.kind, 'state-mismatch');
		});
	});

	suite('decodeTokenResponse', () => {
		test('minimal happy path', () => {
			const r = decodeTokenResponse({ access_token: 'a', token_type: 'Bearer' });
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.accessToken, 'a');
				assert.strictEqual(r.value.tokenType, 'Bearer');
				assert.strictEqual(r.value.expiresInSeconds, undefined);
				assert.strictEqual(r.value.refreshToken, undefined);
			}
		});

		test('full response', () => {
			const r = decodeTokenResponse({
				access_token: 'a', token_type: 'Bearer',
				expires_in: 3600, refresh_token: 'r', scope: 'repo user',
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.expiresInSeconds, 3600);
				assert.strictEqual(r.value.refreshToken, 'r');
				assert.strictEqual(r.value.scope, 'repo user');
			}
		});

		test('rejects missing access_token', () => {
			const r = decodeTokenResponse({ token_type: 'Bearer' });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'access_token-missing'); }
		});

		test('rejects missing token_type', () => {
			const r = decodeTokenResponse({ access_token: 'a' });
			assert.strictEqual(r.ok, false);
		});

		test('non-finite expires_in dropped', () => {
			const r = decodeTokenResponse({ access_token: 'a', token_type: 'Bearer', expires_in: NaN });
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.expiresInSeconds, undefined); }
		});

		test('floors fractional expires_in', () => {
			const r = decodeTokenResponse({ access_token: 'a', token_type: 'Bearer', expires_in: 3600.7 });
			if (r.ok) { assert.strictEqual(r.value.expiresInSeconds, 3600); }
		});
	});

	suite('decideTokenRefresh', () => {
		const NOW = 10_000_000;

		test('fresh token (lots of time left)', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 3600, refreshToken: 'r' },
				nowMs: NOW + 1000,
			});
			assert.strictEqual(r.kind, 'fresh');
		});

		test('expires-soon → should-refresh', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 60, refreshToken: 'r' },
				nowMs: NOW + 50_000,
			});
			assert.strictEqual(r.kind, 'should-refresh');
			if (r.kind === 'should-refresh') { assert.strictEqual(r.reason, 'expires-soon'); }
		});

		test('expired → expired (regardless of refresh token)', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 60, refreshToken: 'r' },
				nowMs: NOW + 100_000,
			});
			assert.strictEqual(r.kind, 'expired');
		});

		test('no expires_in → should-refresh (proactive)', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', refreshToken: 'r' },
				nowMs: NOW + 1000,
			});
			assert.strictEqual(r.kind, 'should-refresh');
			if (r.kind === 'should-refresh') { assert.strictEqual(r.reason, 'no-expires-known'); }
		});

		test('expires-soon without refresh token → no-refresh-token-available', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 60 },
				nowMs: NOW + 50_000,
			});
			assert.strictEqual(r.kind, 'no-refresh-token-available');
		});

		test('expired without refresh → expired (cannot refresh)', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 60 },
				nowMs: NOW + 100_000,
			});
			assert.strictEqual(r.kind, 'expired');
		});

		test('custom refreshLeadMs', () => {
			const r = decideTokenRefresh({
				tokenIssuedAtMs: NOW,
				token: { accessToken: 'a', tokenType: 'Bearer', expiresInSeconds: 60, refreshToken: 'r' },
				nowMs: NOW + 30_000,
				refreshLeadMs: 35_000,
			});
			assert.strictEqual(r.kind, 'should-refresh');
		});
	});
});
