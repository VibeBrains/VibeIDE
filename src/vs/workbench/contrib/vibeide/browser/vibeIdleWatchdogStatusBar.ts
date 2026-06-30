/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Watchdog status bar widget (roadmap W.6 / W.29).
 *
 * Right-aligned entry showing aggregated rss of all tracked VibeIDE processes.
 * Refreshes every 60 seconds (decoupled from the watchdog sample interval — cheaper).
 * Click → opens `VibeIDE: Show Idle Watchdog Timeline` (W.7) if registered.
 *
 * Setting: `vibeide.diagnostics.idleWatchdog.showStatusBar` (default false).
 */

import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { localize } from '../../../../nls.js';
import { IVibeIdleWatchdogProxy } from '../common/vibeIdleWatchdogProxy.js';

const CONFIG_KEY = 'vibeide.diagnostics.idleWatchdog.showStatusBar';
const REFRESH_INTERVAL_MS = 60_000;
const STATUS_ID = 'vibeide.watchdog.statusbar';

function fmt(bytes: number | undefined): string {
	if (!bytes || bytes <= 0) { return '–'; }
	const mb = bytes / (1024 * 1024);
	if (mb < 1024) { return `${Math.round(mb)}M`; }
	return `${(mb / 1024).toFixed(1)}G`;
}

export class VibeIdleWatchdogStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeIdleWatchdogStatusBar';

	private readonly _entry = this._register(new MutableDisposable());
	private readonly _refreshTimer = this._register(new MutableDisposable());

	constructor(
		@IStatusbarService private readonly _statusbar: IStatusbarService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IVibeIdleWatchdogProxy private readonly _proxy: IVibeIdleWatchdogProxy,
	) {
		super();
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration(CONFIG_KEY)) { this._reconfigure(); }
		}));
		this._reconfigure();
	}

	private _reconfigure(): void {
		const enabled = this._config.getValue<boolean>(CONFIG_KEY) === true;
		if (!enabled) {
			this._entry.clear();
			this._refreshTimer.clear();
			return;
		}
		if (this._entry.value) { return; } // already shown
		const entry = this._statusbar.addEntry(this._buildEntry({}), STATUS_ID, StatusbarAlignment.RIGHT, 50);
		this._entry.value = entry;
		const handle = mainWindow.setInterval(() => void this._refresh(), REFRESH_INTERVAL_MS);
		this._refreshTimer.value = { dispose: () => mainWindow.clearInterval(handle) };
		void this._refresh();
	}

	private async _refresh(): Promise<void> {
		try {
			const snapshot = await this._proxy.getCurrentSnapshot();
			const byProc: Record<string, number> = {};
			for (const s of snapshot.samples) {
				byProc[s.proc] = (byProc[s.proc] ?? 0) + s.rss;
			}
			const props = this._buildEntry(byProc);
			const ent = this._entry.value as { update?: (p: IStatusbarEntry) => void } | undefined;
			ent?.update?.(props);
		} catch {
			// Best-effort widget.
		}
	}

	private _buildEntry(byProc: Record<string, number>): IStatusbarEntry {
		const mainRss = byProc['main'] ?? 0;
		const renderRss = byProc['renderer'] ?? 0;
		const extRss = byProc['exthost'] ?? 0;
		const total = mainRss + renderRss + extRss;
		// Color: warning > 1 GB renderer, error > 2 GB any process.
		const overThreshold = renderRss > 1 * 1024 * 1024 * 1024 || total > 2 * 1024 * 1024 * 1024;
		return {
			name: 'VibeIDE Watchdog',
			text: `🧠 ${fmt(mainRss)} / ${fmt(renderRss)} / ${fmt(extRss)}`,
			ariaLabel: localize('vibeide.watchdog.statusbar.aria', 'Потребление памяти вотчдога VibeIDE'),
			tooltip: localize(
				'vibeide.watchdog.statusbar.tooltip',
				'Память VibeIDE: main {0} · renderer {1} · ext-host {2}\nКлик → показать таймлайн вотчдога',
				fmt(mainRss), fmt(renderRss), fmt(extRss),
			),
			command: 'vibeide.watchdog.showTimeline',
			kind: overThreshold ? 'warning' : 'standard',
		};
	}
}

registerWorkbenchContribution2(
	VibeIdleWatchdogStatusBarContribution.ID,
	VibeIdleWatchdogStatusBarContribution,
	WorkbenchPhase.Eventually,
);
