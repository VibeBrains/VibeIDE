/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Unified VibeIDE status-bar contribution (roadmap §K.1 L896).
 *
 * Subscribes to `IVibeUnifiedStatusBarService.onDidChange`, calls
 * `buildUnifiedStatusBarSnapshot`, and renders a single `$(vibeide-logo) VibeIDE`
 * entry (or hides it when all rows are disabled / none registered).
 *
 * Individual VibeIDE features should call `IVibeUnifiedStatusBarService.registerRow()`
 * instead of adding separate status-bar entries.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';

const ENTRY_ID = 'vibeide.unified';
const SHOW_COMMAND = 'vibeide.unified.showStatusPopup';

export class VibeUnifiedStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeUnifiedStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unifiedService: IVibeUnifiedStatusBarService,
	) {
		super();
		this._render();
		this._register(this._unifiedService.onDidChange(() => this._render()));
	}

	private _render(): void {
		const snapshot = this._unifiedService.getSnapshot();
		if (snapshot.primary.hidden) {
			if (this._entry) {
				this._entry.update({ ...this._baseProps(), text: '', ariaLabel: '' });
			}
			return;
		}
		const props = this._buildEntryProps(snapshot.primary.text, snapshot.primary.tooltip);
		if (this._entry) {
			this._entry.update(props);
		} else {
			this._entry = this._statusbarService.addEntry(
				props,
				ENTRY_ID,
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 180 }, alignment: StatusbarAlignment.RIGHT },
			);
		}
	}

	private _baseProps(): IStatusbarEntry {
		return {
			name: localize('vibeide.unified.sb.name', 'VibeIDE'),
			text: '$(vibeide-logo) VibeIDE',
			ariaLabel: localize('vibeide.unified.sb.aria', 'VibeIDE status'),
			tooltip: '',
			command: SHOW_COMMAND,
		};
	}

	private _buildEntryProps(text: string, tooltip: string): IStatusbarEntry {
		return {
			...this._baseProps(),
			text,
			ariaLabel: localize('vibeide.unified.sb.aria', 'VibeIDE status'),
			tooltip,
		};
	}
}

registerWorkbenchContribution2(
	VibeUnifiedStatusBarContribution.ID,
	VibeUnifiedStatusBarContribution,
	WorkbenchPhase.AfterRestored,
);
