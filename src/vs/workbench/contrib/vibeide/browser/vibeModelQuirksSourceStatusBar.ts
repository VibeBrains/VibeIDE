/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Status-bar indicator for the ACTIVE model-quirks catalog source (roadmap 1678).
 *
 * Cheap persistent visibility of "which quirks catalog am I on?" — exe-adjacent override / CDN
 * cache / bundled — plus a ⚠ when the exe-adjacent file is stale. Complements the on-demand
 * `vibeide.modelQuirks.showStatus` command (the click target) and the stale-toast.
 *
 * The quirks status service is read-once (no `onDidChange` over IPC); the active source is fixed
 * for the session at startup, so a single read at `AfterRestored` is enough. Click → showStatus
 * for live detail / refresh. Mirrors `vibeChatModeStatusBar`'s entry/unified-row dual wiring so it
 * respects `vibeide.statusBar.unifiedOnly`.
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IModelQuirksCatalogStatusService, ModelQuirksCatalogStatus } from '../common/modelQuirksCatalogStatusService.js';

const SHOW_STATUS_COMMAND = 'vibeide.modelQuirks.showStatus';
const ENTRY_ID = 'vibeide.modelQuirks.source';

function sourceShort(source: ModelQuirksCatalogStatus['source']): string {
	switch (source) {
		case 'exeAdjacent': return 'exe';
		case 'cdn': return 'CDN';
		case 'bundled': return localize('vibeide.modelQuirks.src.bundled', 'встроен');
		default: return '';
	}
}

export class VibeModelQuirksSourceStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeModelQuirksSourceStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;
	private _status: ModelQuirksCatalogStatus | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
		@IModelQuirksCatalogStatusService private readonly _statusService: IModelQuirksCatalogStatusService,
	) {
		super();
		void this._load();
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private async _load(): Promise<void> {
		try {
			this._status = await this._statusService.getStatus();
		} catch {
			this._status = undefined;
		}
		this._wire();
	}

	private _wire(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		const s = this._status;
		if (!s || s.source === 'empty') { return; } // nothing meaningful to show

		const text = this._text(s);
		const tooltip = this._tooltip(s);
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: ENTRY_ID,
				label: text,
				tooltip,
				priority: 168,
				command: SHOW_STATUS_COMMAND,
			});
		} else {
			this._entry = this._statusbarService.addEntry(
				this._entryProps(s),
				ENTRY_ID,
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 168 }, alignment: StatusbarAlignment.RIGHT }
			);
		}
	}

	private _text(s: ModelQuirksCatalogStatus): string {
		const warn = s.staleExeAdjacent ? '$(warning) ' : '';
		return `${warn}$(database) ${sourceShort(s.source)}`;
	}

	private _tooltip(s: ModelQuirksCatalogStatus): string {
		const lines = [
			localize('vibeide.modelQuirks.sb.title', 'Каталог квирков моделей'),
			localize('vibeide.modelQuirks.sb.source', 'Источник: {0}', sourceShort(s.source) || s.source),
			localize('vibeide.modelQuirks.sb.active', 'Активная дата: {0}', s.activeDate || '—'),
			localize('vibeide.modelQuirks.sb.latest', 'Доступно: {0}', s.latestAvailableDate || '—'),
		];
		if (s.staleExeAdjacent) {
			lines.push(localize('vibeide.modelQuirks.sb.stale', '⚠ exe-adjacent старее доступного каталога.'));
		}
		lines.push(localize('vibeide.modelQuirks.sb.click', 'Клик — подробности / обновление.'));
		return lines.join('\n');
	}

	private _entryProps(s: ModelQuirksCatalogStatus): IStatusbarEntry {
		return {
			name: localize('vibeide.modelQuirks.sb.name', 'VibeIDE model-quirks source'),
			text: this._text(s),
			ariaLabel: localize('vibeide.modelQuirks.sb.aria', 'Model-quirks catalog source: {0}', sourceShort(s.source) || s.source),
			tooltip: this._tooltip(s),
			command: SHOW_STATUS_COMMAND,
		};
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeModelQuirksSourceStatusBarContribution.ID,
	VibeModelQuirksSourceStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
