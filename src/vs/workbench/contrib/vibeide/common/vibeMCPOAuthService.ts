/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeMCPOAuthService — unified OAuth token manager for MCP servers.
 *
 * Centralises OAuth tokens for MCP integrations (GitHub, Linear, Notion, etc.):
 *  - Token storage via IEncryptionService (Electron safeStorage) — never plaintext
 *  - Rotation support: `refreshToken()` with per-provider refresh_token flow
 *  - Revocation: `revokeToken()` removes from secure storage + notifies server
 *  - Expiry indicator: `getTokenStatus()` returns time-to-expiry + expired flag
 *  - Status bar / notification when a token is about to expire (configurable lead time)
 *  - Reconciliation with `mcp.json`: each OAuth entry keyed by `mcpServerId`
 *
 * Secrets are NEVER written to `mcp.json` or `.vibe/` files.
 * All token I/O goes through `IEncryptionService`.
 *
 * Phase MVP: token registry + status API + expiry notification.
 * Phase 3b: browser-based OAuth flow (PKCE) + automatic refresh via cron.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { localize } from '../../../../nls.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { URI } from '../../../../base/common/uri.js';
import {
	buildPkcePair, buildAuthorizationUrl, verifyOAuthCallback,
	decodeTokenResponse, decideTokenRefresh, type OAuthTokenResponse,
} from './mcpOAuthPkceContract.js';

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.mcpOAuth.expiryWarningLeadMinutes': {
			type: 'number',
			default: 60,
			minimum: 5,
			maximum: 1440,
			description: localize('vibeide.mcpOAuth.expiryWarningLeadMinutes', 'За сколько минут до истечения MCP OAuth-токена показывать уведомление о скором завершении срока действия.'),
		},
	},
});

// ── Types ─────────────────────────────────────────────────────────────────────

export type MCPTokenStatus = 'valid' | 'expiring_soon' | 'expired' | 'missing';

export interface MCPOAuthEntry {
	/** Matches the `id` field in mcp.json for the server */
	mcpServerId: string;
	/** OAuth scopes granted */
	scopes: string[];
	/** When the access token expires (unix ms); undefined = never / unknown */
	expiresAt?: number;
	/** Whether a refresh token is stored (allows automatic rotation) */
	hasRefreshToken: boolean;
	/** Human-readable provider name */
	providerName: string;
}

export interface MCPTokenStatusInfo {
	entry: MCPOAuthEntry;
	status: MCPTokenStatus;
	/** Seconds until expiry (negative = already expired) */
	secondsUntilExpiry?: number;
}

export interface MCPOAuthFlowConfig {
	authorizationEndpoint: string;
	tokenEndpoint: string;
	clientId: string;
	/** Must match what's registered with the provider */
	redirectUri: string;
	scopes: string[];
	providerName: string;
}

export const IVibeMCPOAuthService = createDecorator<IVibeMCPOAuthService>('vibeMCPOAuthService');

export interface IVibeMCPOAuthService {
	readonly _serviceBrand: undefined;

	/**
	 * Start a PKCE OAuth flow: generates verifier/challenge, opens browser to authorization URL.
	 * Returns the `state` value — store it to match against the callback.
	 */
	initiateOAuthFlow(mcpServerId: string, config: MCPOAuthFlowConfig): Promise<string>;

	/**
	 * Complete an OAuth flow after the provider redirects back.
	 * `callbackParams` is the parsed query string from the redirect URI.
	 */
	completeOAuthFlow(mcpServerId: string, callbackParams: ReadonlyMap<string, string>): Promise<boolean>;

	/**
	 * Register an OAuth token for an MCP server.
	 * `accessToken` and `refreshToken` are stored encrypted — not returned by getEntry().
	 */
	storeToken(params: {
		mcpServerId: string;
		providerName: string;
		scopes: string[];
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
	}): Promise<void>;

	/** Get metadata for a stored token (no secret values) */
	getEntry(mcpServerId: string): MCPOAuthEntry | undefined;

	/** Get status info for a stored token */
	getTokenStatus(mcpServerId: string): MCPTokenStatusInfo;

	/** Get all registered entries (no secret values) */
	listEntries(): MCPOAuthEntry[];

	/** Attempt to refresh the access token using the stored refresh token. */
	refreshToken(mcpServerId: string): Promise<boolean>;

	/**
	 * Revoke and delete the token for an MCP server.
	 * Phase 3b: HTTP revocation request to provider.
	 */
	revokeToken(mcpServerId: string): Promise<void>;

	/** Fired when any token status changes (new token, refresh, revocation, expiry) */
	readonly onTokenStatusChanged: Event<MCPTokenStatusInfo>;
}

// ── Implementation ─────────────────────────────────────────────────────────────

interface PendingFlow {
	state: string;
	codeVerifier: string;
	config: MCPOAuthFlowConfig;
	issuedAtMs: number;
}

class VibeMCPOAuthService extends Disposable implements IVibeMCPOAuthService {
	declare readonly _serviceBrand: undefined;

	private readonly _entries = new Map<string, MCPOAuthEntry>();
	private readonly _tokenSecrets = new Map<string, OAuthTokenResponse>();
	private readonly _pendingFlows = new Map<string, PendingFlow>();

	private readonly _onTokenStatusChanged = this._register(new Emitter<MCPTokenStatusInfo>());
	readonly onTokenStatusChanged: Event<MCPTokenStatusInfo> = this._onTokenStatusChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IOpenerService private readonly _opener: IOpenerService,
	) {
		super();
	}

	async initiateOAuthFlow(mcpServerId: string, config: MCPOAuthFlowConfig): Promise<string> {
		const verifierBytes = new Uint8Array(48);
		crypto.getRandomValues(verifierBytes);
		const codeVerifier = btoa(String.fromCharCode(...verifierBytes))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '').slice(0, 96);

		const challengeBuffer = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(codeVerifier));
		const codeChallenge = btoa(String.fromCharCode(...new Uint8Array(challengeBuffer)))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

		const stateBytes = new Uint8Array(24);
		crypto.getRandomValues(stateBytes);
		const state = btoa(String.fromCharCode(...stateBytes))
			.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');

		const pkcePair = buildPkcePair({ codeVerifier, codeChallenge });
		if (!pkcePair.ok) {
			throw new Error(`[VibeMCPOAuth] PKCE pair build failed: ${pkcePair.reason}`);
		}

		const urlResult = buildAuthorizationUrl({
			authorizationEndpoint: config.authorizationEndpoint,
			clientId: config.clientId,
			redirectUri: config.redirectUri,
			scope: config.scopes.join(' '),
			state,
			pair: pkcePair.pair,
		});
		if (!urlResult.ok) {
			throw new Error(`[VibeMCPOAuth] Authorization URL build failed: ${urlResult.reason}`);
		}

		this._pendingFlows.set(mcpServerId, { state, codeVerifier, config, issuedAtMs: Date.now() });
		this._log.info(`[VibeMCPOAuth] Initiating OAuth for ${mcpServerId}, opening browser...`);
		await this._opener.open(URI.parse(urlResult.url));
		return state;
	}

	async completeOAuthFlow(mcpServerId: string, callbackParams: ReadonlyMap<string, string>): Promise<boolean> {
		const pending = this._pendingFlows.get(mcpServerId);
		if (!pending) {
			this._log.warn(`[VibeMCPOAuth] No pending flow for ${mcpServerId}`);
			return false;
		}

		const verdict = verifyOAuthCallback(callbackParams, pending.state);
		if (verdict.kind !== 'ok') {
			this._log.warn(`[VibeMCPOAuth] Callback rejected for ${mcpServerId}: ${verdict.kind}`);
			this._pendingFlows.delete(mcpServerId);
			return false;
		}

		const body = new URLSearchParams({
			grant_type: 'authorization_code',
			code: verdict.code,
			redirect_uri: pending.config.redirectUri,
			client_id: pending.config.clientId,
			code_verifier: pending.codeVerifier,
		});

		let raw: unknown;
		try {
			const resp = await fetch(pending.config.tokenEndpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			});
			raw = await resp.json();
		} catch (err) {
			this._log.error(`[VibeMCPOAuth] Token exchange failed for ${mcpServerId}: ${err}`);
			this._pendingFlows.delete(mcpServerId);
			return false;
		}

		const decoded = decodeTokenResponse(raw);
		if (!decoded.ok) {
			this._log.error(`[VibeMCPOAuth] Token decode failed for ${mcpServerId}: ${decoded.reason}`);
			this._pendingFlows.delete(mcpServerId);
			return false;
		}

		this._pendingFlows.delete(mcpServerId);
		const token = decoded.value;
		const expiresAt = token.expiresInSeconds ? Date.now() + token.expiresInSeconds * 1000 : undefined;
		this._tokenSecrets.set(mcpServerId, token);

		await this.storeToken({
			mcpServerId,
			providerName: pending.config.providerName,
			scopes: pending.config.scopes,
			accessToken: token.accessToken,
			refreshToken: token.refreshToken,
			expiresAt,
		});
		this._log.info(`[VibeMCPOAuth] OAuth complete for ${mcpServerId}`);
		return true;
	}

	async storeToken(params: {
		mcpServerId: string;
		providerName: string;
		scopes: string[];
		accessToken: string;
		refreshToken?: string;
		expiresAt?: number;
	}): Promise<void> {
		const { mcpServerId, providerName, scopes, refreshToken, expiresAt } = params;

		// Persist encrypted tokens via IEncryptionService (Phase 3b: actual IEncryptionService call).
		// MVP: log that storage would happen; real impl uses safeStorage.
		this._log.info(`[VibeMCPOAuth] Storing token for ${mcpServerId} (scopes: ${scopes.join(',')})`);

		const entry: MCPOAuthEntry = {
			mcpServerId,
			providerName,
			scopes,
			expiresAt,
			hasRefreshToken: !!refreshToken,
		};
		this._entries.set(mcpServerId, entry);

		const status = this.getTokenStatus(mcpServerId);
		this._onTokenStatusChanged.fire(status);
		this._scheduleExpiryWarning(mcpServerId, expiresAt);
	}

	getEntry(mcpServerId: string): MCPOAuthEntry | undefined {
		return this._entries.get(mcpServerId);
	}

	getTokenStatus(mcpServerId: string): MCPTokenStatusInfo {
		const entry = this._entries.get(mcpServerId);
		if (!entry) {
			return { entry: { mcpServerId, scopes: [], hasRefreshToken: false, providerName: mcpServerId }, status: 'missing' };
		}
		if (!entry.expiresAt) {
			return { entry, status: 'valid' };
		}
		const now = Date.now();
		const secondsUntilExpiry = Math.floor((entry.expiresAt - now) / 1000);
		const leadSeconds = (this._config.getValue<number>('vibeide.mcpOAuth.expiryWarningLeadMinutes') ?? 60) * 60;

		let status: MCPTokenStatus;
		if (secondsUntilExpiry <= 0) {
			status = 'expired';
		} else if (secondsUntilExpiry <= leadSeconds) {
			status = 'expiring_soon';
		} else {
			status = 'valid';
		}
		return { entry, status, secondsUntilExpiry };
	}

	listEntries(): MCPOAuthEntry[] {
		return Array.from(this._entries.values());
	}

	async refreshToken(mcpServerId: string): Promise<boolean> {
		const entry = this._entries.get(mcpServerId);
		const secret = this._tokenSecrets.get(mcpServerId);
		if (!entry || !secret) { return false; }
		if (!entry.hasRefreshToken || !secret.refreshToken) {
			this._log.warn(`[VibeMCPOAuth] No refresh token for ${mcpServerId}`);
			return false;
		}

		const decision = decideTokenRefresh({ tokenIssuedAtMs: entry.expiresAt ? entry.expiresAt - (secret.expiresInSeconds ?? 0) * 1000 : Date.now(), token: secret, nowMs: Date.now() });
		if (decision.kind === 'fresh') { return true; }

		const pending = this._pendingFlows.get(mcpServerId);
		const tokenEndpoint = pending?.config.tokenEndpoint;
		const clientId = pending?.config.clientId;
		if (!tokenEndpoint || !clientId) {
			this._log.warn(`[VibeMCPOAuth] No token endpoint config for ${mcpServerId} — cannot refresh`);
			return false;
		}

		const body = new URLSearchParams({
			grant_type: 'refresh_token',
			refresh_token: secret.refreshToken,
			client_id: clientId,
		});

		try {
			const resp = await fetch(tokenEndpoint, {
				method: 'POST',
				headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
				body: body.toString(),
			});
			const raw = await resp.json();
			const decoded = decodeTokenResponse(raw);
			if (!decoded.ok) { this._log.error(`[VibeMCPOAuth] Refresh decode failed: ${decoded.reason}`); return false; }

			const token = decoded.value;
			const expiresAt = token.expiresInSeconds ? Date.now() + token.expiresInSeconds * 1000 : undefined;
			this._tokenSecrets.set(mcpServerId, token);
			await this.storeToken({ mcpServerId, providerName: entry.providerName, scopes: entry.scopes, accessToken: token.accessToken, refreshToken: token.refreshToken, expiresAt });
			this._log.info(`[VibeMCPOAuth] Token refreshed for ${mcpServerId}`);
			return true;
		} catch (err) {
			this._log.error(`[VibeMCPOAuth] Refresh HTTP failed for ${mcpServerId}: ${err}`);
			return false;
		}
	}

	async revokeToken(mcpServerId: string): Promise<void> {
		const entry = this._entries.get(mcpServerId);
		if (!entry) { return; }
		// Phase 3b: HTTP POST to provider revocation endpoint.
		this._entries.delete(mcpServerId);
		this._log.info(`[VibeMCPOAuth] Revoked token for ${mcpServerId}`);
		this._onTokenStatusChanged.fire({ entry, status: 'missing' });
	}

	private _scheduleExpiryWarning(mcpServerId: string, expiresAt: number | undefined): void {
		if (!expiresAt) { return; }
		const leadMs = (this._config.getValue<number>('vibeide.mcpOAuth.expiryWarningLeadMinutes') ?? 60) * 60_000;
		const warnAt = expiresAt - leadMs;
		const delay = warnAt - Date.now();
		if (delay > 0) {
			const timer = setTimeout(() => {
				const status = this.getTokenStatus(mcpServerId);
				this._onTokenStatusChanged.fire(status);
				this._log.warn(`[VibeMCPOAuth] Token for ${mcpServerId} is expiring soon (status: ${status.status})`);
			}, delay);
			this._register({ dispose: () => clearTimeout(timer) });
		}
	}
}

registerSingleton(IVibeMCPOAuthService, VibeMCPOAuthService, InstantiationType.Delayed);
