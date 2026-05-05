/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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

// ── Configuration ─────────────────────────────────────────────────────────────

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	properties: {
		'vibeide.mcpOAuth.expiryWarningLeadMinutes': {
			type: 'number',
			default: 60,
			minimum: 5,
			maximum: 1440,
			description: localize('vibeide.mcpOAuth.expiryWarningLeadMinutes', 'Minutes before an MCP OAuth token expires to show an expiry warning notification.'),
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

export const IVibeMCPOAuthService = createDecorator<IVibeMCPOAuthService>('vibeMCPOAuthService');

export interface IVibeMCPOAuthService {
	readonly _serviceBrand: undefined;

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

	/**
	 * Attempt to refresh the access token using the stored refresh token.
	 * Phase 3b: real HTTP call to provider token endpoint.
	 */
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

class VibeMCPOAuthService extends Disposable implements IVibeMCPOAuthService {
	declare readonly _serviceBrand: undefined;

	// In-memory metadata (no secrets). Secrets are in IEncryptionService storage.
	private readonly _entries = new Map<string, MCPOAuthEntry>();

	private readonly _onTokenStatusChanged = this._register(new Emitter<MCPTokenStatusInfo>());
	readonly onTokenStatusChanged: Event<MCPTokenStatusInfo> = this._onTokenStatusChanged.event;

	constructor(
		@ILogService private readonly _log: ILogService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		// Phase 3b: load persisted metadata from workspaceStorage + start expiry monitor timer.
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
		if (!entry) { return false; }
		if (!entry.hasRefreshToken) {
			this._log.warn(`[VibeMCPOAuth] No refresh token for ${mcpServerId}`);
			return false;
		}
		// Phase 3b: HTTP POST to provider /token endpoint with grant_type=refresh_token.
		this._log.info(`[VibeMCPOAuth] [Phase 3b stub] Would refresh token for ${mcpServerId}`);
		return false;
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
