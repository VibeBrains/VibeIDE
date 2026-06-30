/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — capture-phase mousedown interceptor on the title-bar
 * menubar button labelled "Команды". When the user clicks it, the native
 * VS Code menu dropdown is suppressed and our custom popup
 * (`showProjectCommandsPopup`) is opened instead — same anchor, same look,
 * but with the inline Pin / Edit / Delete action affordances that the stock
 * menubar widget cannot render.
 *
 * Capture phase is required: the `Menubar` widget binds its own mousedown
 * handler on the button which would otherwise fire first and open the
 * native dropdown.
 *
 * Locale note — the aria-label on the menubar button is the mnemonic-stripped
 * title. We match the **registered** value `'Команды'` (see
 * `menubar.contribution.ts` for `MenubarVibeProjectCommandsMenu`) plus the
 * English original `'Commands'` as a fallback, so the interceptor stays
 * correct regardless of the workbench language pack.
 */

import { addDisposableListener, EventType, getActiveDocument } from '../../../../base/browser/dom.js';
import { Disposable, DisposableStore } from '../../../../base/common/lifecycle.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { showProjectCommandsPopup } from './vibeProjectCommandsPopup.js';

/** Brief grace period after the popup auto-closes (e.g. via outside-click on
 *  the menubar button itself, which the IContextView blur handler treats as
 *  "outside") during which we ignore re-open attempts. Without it the same
 *  mousedown that closes the popup also opens a fresh one — popup looks
 *  "stuck" open instead of toggling. */
const REOPEN_GUARD_MS = 200;

/** aria-label values that identify the title-bar "Команды" menubar button.
 *  Includes the Russian (default) value and the English original to survive
 *  language-pack switches. */
const TARGET_ARIA_LABELS = new Set<string>(['Команды', 'Commands']);

export class VibeProjectCommandsPopupContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProjectCommandsPopup';

	private readonly _listener = this._register(new DisposableStore());
	private _openHandle: { close: () => void } | undefined;
	private _lastHideAt = 0;

	constructor(
		@IVibeCustomCommandsService private readonly _commandsService: IVibeCustomCommandsService,
		@ICommandService private readonly _commandService: ICommandService,
		@IContextViewService private readonly _contextViewService: IContextViewService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@INotificationService private readonly _notifications: INotificationService,
	) {
		super();
		this._install();
	}

	private _install(): void {
		const doc = getActiveDocument();
		// Mousedown (not click) — the Menubar widget opens its dropdown on
		// pointerdown / mousedown. Click would fire too late.
		this._listener.add(addDisposableListener(doc, EventType.MOUSE_DOWN, (e: MouseEvent) => {
			const target = e.target as HTMLElement | null;
			if (!target) { return; }
			const button = target.closest<HTMLElement>('.menubar-menu-button');
			if (!button) { return; }
			const ariaLabel = button.getAttribute('aria-label') ?? '';
			if (!TARGET_ARIA_LABELS.has(ariaLabel)) {
				// Click landed on a different menubar button. VS Code's Menubar widget
				// stops propagation on its own button mousedowns before IContextView's
				// outside-click handler sees them, so our popup would stay open and
				// overlap the freshly-opened native dropdown. Close it explicitly.
				if (this._openHandle) {
					this._openHandle.close();
					this._openHandle = undefined;
				}
				return;
			}
			// Only intercept left mouse button — context menus stay native.
			if (e.button !== 0) { return; }
			e.preventDefault();
			e.stopImmediatePropagation();

			// Toggle behaviour: if the popup is currently open, close it and
			// do NOT reopen. Without this the popup would stay visible until
			// the user picked something or clicked far outside.
			if (this._openHandle) {
				this._openHandle.close();
				this._openHandle = undefined;
				return;
			}
			// Grace window: when contextView's outside-click closer fires due
			// to a mousedown on this very button, the close happens *before*
			// our handler; without the guard we'd immediately reopen.
			if (Date.now() - this._lastHideAt < REOPEN_GUARD_MS) {
				return;
			}

			this._openHandle = showProjectCommandsPopup({
				commandsService: this._commandsService,
				commandService: this._commandService,
				contextViewService: this._contextViewService,
				fileService: this._fileService,
				workspace: this._workspace,
				notifications: this._notifications,
			}, button, {
				onHide: () => {
					this._openHandle = undefined;
					this._lastHideAt = Date.now();
				},
			});
		}, /* useCapture */ true));
	}
}

registerWorkbenchContribution2(
	VibeProjectCommandsPopupContribution.ID,
	VibeProjectCommandsPopupContribution,
	WorkbenchPhase.AfterRestored,
);
