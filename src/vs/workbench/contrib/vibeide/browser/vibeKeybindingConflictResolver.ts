/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IExtensionService } from '../../../services/extensions/common/extensions.js';
import { IVibeKeyboardShortcutsService } from './vibeKeyboardShortcutsService.js';
import { localize } from '../../../../nls.js';

/**
 * VibeIDE Keybinding Conflict Resolver.
 * When an extension is installed, checks for conflicts with VibeIDE shortcuts.
 * Without this, Trust Score Ctrl+Shift+T breaks on first vim-mode install.
 */
export class VibeKeybindingConflictResolverContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeKeybindingConflictResolver';

	constructor(
		@INotificationService private readonly _notificationService: INotificationService,
		@IExtensionService private readonly _extensionService: IExtensionService,
		@IVibeKeyboardShortcutsService private readonly _keyboardService: IVibeKeyboardShortcutsService,
	) {
		super();
		this._register(this._extensionService.onDidChangeExtensions(() => {
			this._checkConflicts();
		}));
	}

	private _checkConflicts(): void {
		// Phase 1: detect common conflicting extensions
		const KNOWN_CONFLICTS: Record<string, Array<{ key: string; command: string }>> = {
			'vscodevim.vim': [
				{ key: 'ctrl+shift+t', command: 'vim toggle' },
			],
			'asvetliakov.vscode-neovim': [
				{ key: 'ctrl+shift+p', command: 'neovim command mode' },
			],
		};

		const extensions = this._extensionService.extensions;
		for (const ext of extensions) {
			const conflicts_list = KNOWN_CONFLICTS[ext.identifier.value.toLowerCase()];
			if (!conflicts_list) { continue; }

			const conflicts = this._keyboardService.checkConflicts(conflicts_list);
			if (conflicts.length > 0) {
				this._notificationService.notify({
					severity: Severity.Warning,
					message: localize(
						'vibeKeybindingConflict',
						'VibeIDE: Keyboard conflict detected with {0}. {1} shortcut(s) may not work. Open Keyboard Shortcuts to resolve.',
						ext.displayName || ext.identifier.value,
						conflicts.length
					),
				});
			}
		}
	}
}

registerWorkbenchContribution2(
	VibeKeybindingConflictResolverContribution.ID,
	VibeKeybindingConflictResolverContribution,
	WorkbenchPhase.AfterRestored
);
