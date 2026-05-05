/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';

export interface VibeKeyboardShortcut {
	command: string;
	key: string;
	when?: string;
	description: string;
}

export const VIBE_KEYBOARD_SHORTCUTS: VibeKeyboardShortcut[] = [
	// Trust Score
	{ command: 'vibeide.trustScore.toggle', key: 'ctrl+shift+t', description: 'Toggle Trust Score level' },
	{ command: 'vibeide.trustScore.setManual', key: 'ctrl+shift+1', description: 'Set Trust Score to Manual 🟢' },
	{ command: 'vibeide.trustScore.setSupervised', key: 'ctrl+shift+2', description: 'Set Trust Score to Supervised 🟡' },
	{ command: 'vibeide.trustScore.setAuto', key: 'ctrl+shift+3', description: 'Set Trust Score to Auto 🔴' },

	// Tool approval
	{ command: 'vibeide.toolApproval.approve', key: 'enter', when: 'vibeide.toolApprovalPending', description: 'Approve pending tool use' },
	{ command: 'vibeide.toolApproval.reject', key: 'escape', when: 'vibeide.toolApprovalPending', description: 'Reject pending tool use' },

	// Diff review
	{ command: 'vibeide.diff.apply', key: 'ctrl+enter', when: 'vibeide.diffPreviewOpen', description: 'Apply diff' },
	{ command: 'vibeide.diff.reject', key: 'ctrl+backspace', when: 'vibeide.diffPreviewOpen', description: 'Reject diff' },
	{ command: 'vibeide.diff.edit', key: 'ctrl+shift+e', when: 'vibeide.diffPreviewOpen', description: 'Edit before applying' },

	// Agent control
	{ command: 'vibeide.agent.pauseAndExplain', key: 'ctrl+shift+p', when: 'vibeide.agentRunning', description: 'Pause agent and ask what it\'s doing' },
	{ command: 'vibeide.agent.cancel', key: 'ctrl+shift+c', when: 'vibeide.agentRunning', description: 'Cancel agent task' },

	// Editor shortcuts
	{ command: 'vibeide.explainLine', key: 'ctrl+.', description: 'Explain current line (inline)' },
	{ command: 'vibeide.freezeCode', key: 'ctrl+shift+f', when: 'editorHasSelection', description: 'Freeze selected code for agent' },

	// Pre-flight plan
	{ command: 'vibeide.preFlight.approve', key: 'enter', when: 'vibeide.preFlightPlanOpen', description: 'Approve pre-flight plan' },
	{ command: 'vibeide.preFlight.cancel', key: 'escape', when: 'vibeide.preFlightPlanOpen', description: 'Cancel pre-flight plan' },

	// Plan Mode
	{ command: 'vibeide.chatMode.plan', key: 'ctrl+shift+alt+p', description: 'Switch chat to Plan mode — explore & plan, no mutations' },
];

export const IVibeKeyboardShortcutsService = createDecorator<IVibeKeyboardShortcutsService>('vibeKeyboardShortcutsService');

export interface IVibeKeyboardShortcutsService {
	readonly _serviceBrand: undefined;

	/** Get all VibeIDE keyboard shortcuts */
	getAllShortcuts(): VibeKeyboardShortcut[];

	/** Check for conflicts with extension shortcuts */
	checkConflicts(extensionKeybindings: Array<{ key: string; command: string }>): Array<{ vibeCommand: string; conflictingCommand: string; key: string }>;
}

/**
 * VibeIDE Keyboard Shortcuts Service.
 * Keyboard-first design — all VibeIDE actions fully keyboard accessible.
 * Checks for conflicts with installed extensions.
 */
class VibeKeyboardShortcutsService extends Disposable implements IVibeKeyboardShortcutsService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._logService.debug(`[VibeIDE Keyboard] ${VIBE_KEYBOARD_SHORTCUTS.length} shortcuts registered`);
	}

	getAllShortcuts(): VibeKeyboardShortcut[] {
		return [...VIBE_KEYBOARD_SHORTCUTS];
	}

	checkConflicts(extensionKeybindings: Array<{ key: string; command: string }>): Array<{ vibeCommand: string; conflictingCommand: string; key: string }> {
		const conflicts = [];
		for (const vibe of VIBE_KEYBOARD_SHORTCUTS) {
			const conflict = extensionKeybindings.find(ext => ext.key.toLowerCase() === vibe.key.toLowerCase());
			if (conflict) {
				conflicts.push({
					vibeCommand: vibe.command,
					conflictingCommand: conflict.command,
					key: vibe.key,
				});
				this._logService.warn(`[VibeIDE Keyboard] Conflict: ${vibe.key} (${vibe.command} vs ${conflict.command})`);
			}
		}
		return conflicts;
	}
}

registerSingleton(IVibeKeyboardShortcutsService, VibeKeyboardShortcutsService, InstantiationType.Eager);
