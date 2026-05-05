/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IVibeConstraintsService } from '../common/vibeConstraintsService.js';

const EXPECTED_VIBE_VERSION = '1.0.0';
const VIBE_FILES_TO_CHECK = ['constraints.json', 'allowed-models.json', 'pinned.json'];

/**
 * VibeIDE: Startup health check for .vibe/ configuration files.
 * Runs at startup in ≤30ms (non-blocking).
 * Shows banner if schema version mismatch detected.
 */
export class VibeStartupHealthCheckContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeStartupHealthCheck';

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@ILogService private readonly _logService: ILogService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IVibeConstraintsService _constraintsService: IVibeConstraintsService,
	) {
		super();
		// Non-blocking: run in background after workbench restore
		setTimeout(() => this._runHealthCheck(), 0);
	}

	private async _runHealthCheck(): Promise<void> {
		const start = Date.now();
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return;

		const vibeDir = joinPath(folders[0].uri, '.vibe');
		const issues: string[] = [];

		for (const fileName of VIBE_FILES_TO_CHECK) {
			const fileUri = joinPath(vibeDir, fileName);
			try {
				const content = await this._fileService.readFile(fileUri);
				const data = JSON.parse(content.value.toString());
				if (!data.vibeVersion) {
					issues.push(`${fileName}: missing vibeVersion field`);
				} else if (data.vibeVersion !== EXPECTED_VIBE_VERSION) {
					issues.push(`${fileName}: version ${data.vibeVersion} (expected ${EXPECTED_VIBE_VERSION}) — may need migration`);
				}
			} catch {
				// File missing — OK (will be created by VibeConfigInitContribution)
			}
		}

		const elapsed = Date.now() - start;
		this._logService.debug(`[VibeIDE HealthCheck] Completed in ${elapsed}ms. Issues: ${issues.length}`);

		if (issues.length > 0) {
			this._logService.warn(`[VibeIDE HealthCheck] .vibe/ schema issues:\n${issues.join('\n')}`);
			this._notificationService.notify({
				severity: Severity.Warning,
				message: `VibeIDE: .vibe/ configuration may need migration (${issues.length} issue(s)). Run \`vibe doctor --repair\` to fix.`,
			});
		}
	}
}

registerWorkbenchContribution2(
	VibeStartupHealthCheckContribution.ID,
	VibeStartupHealthCheckContribution,
	WorkbenchPhase.AfterRestored
);
