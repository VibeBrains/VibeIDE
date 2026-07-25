/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * MCP OAuth token rotation.
 *
 * MCP servers authorize through the workbench's dynamic authentication providers, so the
 * authorization state lives in three upstream places and nowhere in VibeIDE:
 *   - `IDynamicAuthenticationProviderStorageService` — stored tokens with `created_at`,
 *     `expires_in` and whether a refresh token came with them;
 *   - `IAuthenticationService` — the sessions themselves (account label, session id);
 *   - `IAuthenticationMcpUsageService` — which MCP server used which account, and when.
 *
 * This contribution joins the three (`buildMcpTokenRecords`), runs the pure policy
 * (`decideRotationsForAll`) every ROTATION_SCAN_INTERVAL_MS, and applies the verdicts:
 * `remind` raises a notification, `auto-revoke` removes the session. Revoking removes the
 * SESSION only — the dynamic client registration stays, so signing back in does not need
 * another dynamic registration round-trip.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { IAuthenticationService } from '../../../services/authentication/common/authentication.js';
import { IDynamicAuthenticationProviderStorageService } from '../../../services/authentication/common/dynamicAuthenticationProviderStorage.js';
import { IAuthenticationMcpUsageService } from '../../../services/authentication/browser/authenticationMcpUsageService.js';
import { IMcpService } from '../../mcp/common/mcpTypes.js';
import {
	buildMcpTokenRecords,
	decideRotationsForAll,
	McpTokenRotationTarget,
	UpstreamAuthSession,
	UpstreamProviderTokens,
} from '../common/mcpTokenRotationPolicy.js';
import {
	MCP_ROTATION_HARD_LIMIT_DAYS_KEY,
	MCP_ROTATION_IDLE_REVOKE_DAYS_KEY,
	MCP_ROTATION_REMINDER_DAYS_KEY,
	rotationConfigFromDays,
} from '../common/mcpTokenRotationConfiguration.js';

const ROTATION_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

/** Map key for one session. JSON-encoded so an account label containing the separator can't collide. */
function sessionKey(providerId: string, accountLabel: string): string {
	return JSON.stringify([providerId, accountLabel]);
}

export class VibeMCPTokenRotationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeMCPTokenRotation';

	private _scanTimer: number | null = null;
	private _scanInFlight = false;

	constructor(
		@IAuthenticationService private readonly _authentication: IAuthenticationService,
		@IDynamicAuthenticationProviderStorageService private readonly _dynamicAuthStorage: IDynamicAuthenticationProviderStorageService,
		@IAuthenticationMcpUsageService private readonly _mcpAuthUsage: IAuthenticationMcpUsageService,
		@IMcpService private readonly _mcpService: IMcpService,
		@INotificationService private readonly _notifications: INotificationService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// Initial scan after workbench restore.
		void this._scan();

		// Periodic scan.
		this._scanTimer = mainWindow.setInterval(() => { void this._scan(); }, ROTATION_SCAN_INTERVAL_MS);
		this._register({ dispose: () => { if (this._scanTimer) { mainWindow.clearInterval(this._scanTimer); this._scanTimer = null; } } });

		// Re-scan when stored tokens change (new login, refresh, sign-out) so a removed
		// server's leftover session is dealt with promptly instead of up to a day later.
		this._register(this._dynamicAuthStorage.onDidChangeTokens(() => { void this._scan(); }));
	}

	/** Collect what the workbench knows about MCP authorization, per dynamic provider. */
	private async _collectUpstreamTokens(): Promise<{ providers: UpstreamProviderTokens[]; sessionIdOf: Map<string, string> }> {
		const providers: UpstreamProviderTokens[] = [];
		// (providerId, accountLabel) → session id, for revoking exactly the right session.
		const sessionIdOf = new Map<string, string>();

		for (const provider of this._dynamicAuthStorage.getInteractedProviders()) {
			const stored = await this._dynamicAuthStorage.getSessionsForDynamicAuthProvider(provider.providerId, provider.clientId);
			if (!stored?.length) {
				continue;
			}
			// The stored entries are raw token responses without an account, while the sessions
			// carry the account but no issue time. The access token is what ties the two together.
			const storedByAccessToken = new Map(stored.map(entry => [entry.access_token, entry]));
			const sessions = await this._authentication.getSessions(provider.providerId);

			const usagesOfAccount = new Map<string, { mcpServerId: string; accountLabel: string; lastUsed: number }[]>();
			const providerSessions: UpstreamAuthSession[] = [];

			for (const session of sessions) {
				const raw = storedByAccessToken.get(session.accessToken);
				if (!raw) {
					continue;
				}
				const accountLabel = session.account.label;
				sessionIdOf.set(sessionKey(provider.providerId, accountLabel), session.id);
				providerSessions.push({
					createdAt: raw.created_at,
					expiresInSeconds: raw.expires_in,
					hasRefreshToken: typeof raw.refresh_token === 'string' && raw.refresh_token.length > 0,
					accountLabel,
				});
				if (!usagesOfAccount.has(accountLabel)) {
					usagesOfAccount.set(accountLabel, this._mcpAuthUsage.readAccountUsages(provider.providerId, accountLabel)
						.map(usage => ({ mcpServerId: usage.mcpServerId, accountLabel, lastUsed: usage.lastUsed })));
				}
			}

			const usages = [...usagesOfAccount.values()].flat();
			if (usages.length > 0) {
				providers.push({ providerId: provider.providerId, sessions: providerSessions, usages });
			}
		}

		return { providers, sessionIdOf };
	}

	private async _scan(): Promise<void> {
		if (this._scanInFlight) {
			return; // token refreshes can fire onDidChangeTokens in bursts
		}
		this._scanInFlight = true;
		try {
			await this._scanOnce();
		} finally {
			this._scanInFlight = false;
		}
	}

	private async _scanOnce(): Promise<void> {
		const knownServerIds = new Set(this._mcpService.servers.get().map(server => server.definition.id));
		if (knownServerIds.size === 0) {
			// The server list is empty right after startup, before collections are resolved. Acting on
			// it would read every stored login as "its server is gone" and revoke the lot. Wait for the
			// next scan instead — `onDidChangeTokens` and the daily timer both come back here.
			return;
		}

		const { providers, sessionIdOf } = await this._collectUpstreamTokens();
		if (providers.length === 0) {
			return;
		}

		const targets = buildMcpTokenRecords(providers);
		if (targets.length === 0) {
			return;
		}

		const config = rotationConfigFromDays({
			reminder: this._configuration.getValue<number>(MCP_ROTATION_REMINDER_DAYS_KEY),
			hardLimit: this._configuration.getValue<number>(MCP_ROTATION_HARD_LIMIT_DAYS_KEY),
			idleRevoke: this._configuration.getValue<number>(MCP_ROTATION_IDLE_REVOKE_DAYS_KEY),
		});

		const targetOfServer = new Map<string, McpTokenRotationTarget>(targets.map(target => [target.record.serverId, target]));
		const decisions = decideRotationsForAll(targets.map(target => target.record), Date.now(), knownServerIds, config);

		for (const decision of decisions) {
			if (decision.kind === 'auto-revoke') {
				const target = targetOfServer.get(decision.serverId);
				const sessionId = target && sessionIdOf.get(sessionKey(target.providerId, target.accountLabel));
				if (!target || !sessionId) {
					continue;
				}
				this._log.info(`[MCPTokenRotation] Revoking session for ${decision.serverId} (reason: ${decision.reason})`);
				try {
					await this._authentication.removeSession(target.providerId, sessionId);
				} catch (e) {
					this._log.warn(`[MCPTokenRotation] Failed to revoke session for ${decision.serverId}: ${(e as Error).message}`);
				}
			} else if (decision.kind === 'remind') {
				const msg = decision.reason === 'expires-soon'
					? localize('vibeide.mcpRotation.expiresSoon', 'Авторизация MCP-сервера «{0}» скоро истечёт. Войдите заново, чтобы сервер не отключился посреди работы.', decision.serverId)
					: localize('vibeide.mcpRotation.softDue', 'Авторизация MCP-сервера «{0}» старше {1} дней. Стоит войти заново — так старый токен перестанет действовать.', decision.serverId, Math.round(config.rotationReminderAfterMs / (24 * 60 * 60 * 1000)));
				this._notifications.notify({ severity: Severity.Warning, message: msg });
			}
		}
	}
}

registerWorkbenchContribution2(
	VibeMCPTokenRotationContribution.ID,
	VibeMCPTokenRotationContribution,
	WorkbenchPhase.AfterRestored,
);
