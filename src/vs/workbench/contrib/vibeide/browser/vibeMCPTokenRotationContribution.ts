/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * MCP OAuth token rotation wrapper (roadmap §K.2 / line 919).
 *
 * Runs a periodic check (every ROTATION_SCAN_INTERVAL_MS) against
 * `IVibeMCPOAuthService.listEntries()` combined with the known MCP server
 * ids from `IMCPService.state`. Uses `decideRotationsForAll` (pure helper)
 * to decide what action to take:
 *
 *  - `auto-revoke`: calls `IVibeMCPOAuthService.revokeToken(serverId)`
 *    (which deletes from IEncryptionService secure storage once Phase 3b lands).
 *  - `remind`: fires a notification to the user.
 *
 * Also re-scans on every `IMCPService.onDidChangeState` (server list change)
 * so that tokens for removed servers are revoked promptly.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { mainWindow } from '../../../../base/browser/window.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { localize } from '../../../../nls.js';
import { IVibeMCPOAuthService } from '../common/vibeMCPOAuthService.js';
import { IMCPService } from '../common/mcpService.js';
import {
	decideRotationsForAll,
	MCPTokenRecord,
} from '../common/mcpTokenRotationPolicy.js';

const ROTATION_SCAN_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24 hours

export class VibeMCPTokenRotationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeMCPTokenRotation';

	private _scanTimer: number | null = null;

	constructor(
		@IVibeMCPOAuthService private readonly _oauthService: IVibeMCPOAuthService,
		@IMCPService private readonly _mcpService: IMCPService,
		@INotificationService private readonly _notifications: INotificationService,
		@ILogService private readonly _log: ILogService,
	) {
		super();

		// Initial scan after workbench restore.
		void this._scan();

		// Periodic scan.
		this._scanTimer = mainWindow.setInterval(() => { void this._scan(); }, ROTATION_SCAN_INTERVAL_MS);
		this._register({ dispose: () => { if (this._scanTimer) { mainWindow.clearInterval(this._scanTimer); this._scanTimer = null; } } });

		// Re-scan when MCP server list changes (catches server-removed case promptly).
		this._register(this._mcpService.onDidChangeState(() => { void this._scan(); }));
	}

	private async _scan(): Promise<void> {
		const entries = this._oauthService.listEntries();
		if (entries.length === 0) {
			return;
		}

		const knownServerIds = new Set(Object.keys(this._mcpService.state.mcpServerOfName));
		const now = Date.now();

		// Map MCPOAuthEntry → MCPTokenRecord (storedAt defaults to now for entries
		// without an explicit stored timestamp; age-based rotation will be fully
		// accurate once IVibeMCPOAuthService surfaces storedAt in Phase 3b).
		const tokens: MCPTokenRecord[] = entries.map(e => ({
			serverId: e.mcpServerId,
			provider: e.providerName,
			storedAt: now, // conservative — prevents false-positive age-based revokes
			lastUsedAt: null,
			expiresAt: e.expiresAt,
		}));

		const decisions = decideRotationsForAll(tokens, now, knownServerIds);
		for (const decision of decisions) {
			if (decision.kind === 'auto-revoke') {
				this._log.info(`[MCPTokenRotation] Auto-revoking token for ${decision.serverId} (reason: ${decision.reason})`);
				try {
					await this._oauthService.revokeToken(decision.serverId);
				} catch (e) {
					this._log.warn(`[MCPTokenRotation] Failed to revoke token for ${decision.serverId}: ${(e as Error).message}`);
				}
			} else if (decision.kind === 'remind') {
				const msg = decision.reason === 'expires-soon'
					? localize('vibeide.mcpRotation.expiresSoon', 'MCP OAuth token for server "{0}" expires soon. Please rotate it via Settings → MCP Servers.', decision.serverId)
					: localize('vibeide.mcpRotation.softDue', 'MCP OAuth token for server "{0}" is over 90 days old. Consider rotating it via Settings → MCP Servers.', decision.serverId);
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
