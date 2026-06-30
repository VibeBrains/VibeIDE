/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';

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
			ariaLabel: localize('vibeide.unified.sb.aria', 'Статус VibeIDE'),
			tooltip: '',
			command: SHOW_COMMAND,
		};
	}

	private _buildEntryProps(text: string, tooltip: string): IStatusbarEntry {
		return {
			...this._baseProps(),
			text,
			ariaLabel: localize('vibeide.unified.sb.aria', 'Статус VibeIDE'),
			tooltip,
		};
	}
}

registerWorkbenchContribution2(
	VibeUnifiedStatusBarContribution.ID,
	VibeUnifiedStatusBarContribution,
	WorkbenchPhase.AfterRestored,
);

// Popup quick-pick — opens on click of the unified status entry. Each row shows
// label + optional counter + tooltip; selecting a row with `command` invokes it.
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: SHOW_COMMAND,
			title: { value: localize('vibeide.unified.showPopup', 'Показать всплывающее окно статуса'), original: 'Show Status Popup' },
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const unified = accessor.get(IVibeUnifiedStatusBarService);
		const quickInput = accessor.get(IQuickInputService);
		const commands = accessor.get(ICommandService);
		const snapshot = unified.getSnapshot();
		if (snapshot.popupRows.length === 0) { return; }
		const items = snapshot.popupRows.map(r => ({
			id: r.id,
			label: typeof r.counter === 'number' && r.counter > 0 ? `${r.label} (${Math.floor(r.counter)})` : r.label,
			description: r.severity && r.severity !== 'info' ? `[${r.severity}]` : undefined,
			detail: r.tooltip,
			command: r.command,
		}));
		const picked = await quickInput.pick(items, {
			title: localize('vibeide.unified.popupTitle', 'Статус VibeIDE'),
			placeHolder: localize('vibeide.unified.popupPh', 'Выберите для открытия связанной панели или действия'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (picked?.command) {
			try { await commands.executeCommand(picked.command); } catch { /* swallow */ }
		}
	}
});
