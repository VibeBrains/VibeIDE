/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * VibeSubagentStatusBarContribution — UI for active subagents in the status bar.
 *
 * Phase MVP: status bar item showing count of active subagents + click → list picker.
 * Shows token count and type per subagent; collapsed by default.
 *
 * Phase 3b: collapsible inline card under the parent chat turn in the sidebar React component.
 *
 * Privacy gate: Deep-link "full transcript" only available when audit is enabled
 * (vibeide.audit.enable = true) and stealth mode is OFF.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkbenchContributionsRegistry, Extensions as WorkbenchExtensions } from '../../../common/contributions.js';
import { LifecyclePhase } from '../../../services/lifecycle/common/lifecycle.js';
import { IStatusbarService, StatusbarAlignment, IStatusbarEntryAccessor } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeSubagentService, SubagentEntry } from '../common/vibeSubagentService.js';
import { localize } from '../../../../nls.js';

// Status bar item id
const STATUS_ID = 'vibeide.subagentStatus';

class VibeSubagentStatusBarContribution extends Disposable {

	private _accessor: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IVibeSubagentService private readonly _subagentSvc: IVibeSubagentService,
	) {
		super();
		// Subscribe to subagent status changes
		this._register(this._subagentSvc.onSubagentStatusChanged(() => this._update()));
		this._update();
	}

	private _getActiveEntries(): SubagentEntry[] {
		// Get all registry entries (non-disposed)
		const seen = new Set<string>();
		const result: SubagentEntry[] = [];
		for (const entry of this._subagentSvc.getAll()) {
			if (!seen.has(entry.id) && entry.status !== 'disposed') {
				seen.add(entry.id);
				result.push(entry);
			}
		}
		return result;
	}

	private _update(): void {
		const active = this._getActiveEntries();
		const running = active.filter(e => e.status === 'running' || e.status === 'pending');

		if (running.length === 0) {
			// Hide when no active subagents
			this._accessor?.dispose();
			this._accessor = undefined;
			return;
		}

		const text = `$(loading~spin) ${localize('vibeide.subagent.statusbar', 'Subagents: {0}', running.length)}`;
		const tooltip = running.map(e => `[${e.type}] ${e.handoff.goal.slice(0, 60)}`).join('\n');
		const name = localize('vibeide.subagent.statusbarName', 'VibeIDE Subagents');

		if (this._accessor) {
			this._accessor.update({ name, text, tooltip, ariaLabel: text, command: 'vibeide.subagent.listActive' });
		} else {
			this._accessor = this._register(this._statusbar.addEntry({
				name,
				text,
				tooltip,
				ariaLabel: text,
				command: 'vibeide.subagent.listActive',
			}, STATUS_ID, StatusbarAlignment.RIGHT, 500));
		}
	}
}

Registry.as<IWorkbenchContributionsRegistry>(WorkbenchExtensions.Workbench).registerWorkbenchContribution(
	VibeSubagentStatusBarContribution,
	LifecyclePhase.Restored
);
