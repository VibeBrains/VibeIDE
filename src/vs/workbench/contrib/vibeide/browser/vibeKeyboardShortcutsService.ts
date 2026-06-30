/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { localize } from '../../../../nls.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface VibeKeyboardShortcut {
	command: string;
	key: string;
	when?: string;
	description: string;
}

export const VIBE_KEYBOARD_SHORTCUTS: VibeKeyboardShortcut[] = [
	// Trust Score
	{ command: 'vibeide.trustScore.toggle', key: 'ctrl+shift+t', description: localize('vibeide.keyboard.trustScore.toggle', 'Переключить уровень Trust Score') },
	{ command: 'vibeide.trustScore.setManual', key: 'ctrl+shift+1', description: localize('vibeide.keyboard.trustScore.setManual', 'Установить Trust Score: Manual 🟢') },
	{ command: 'vibeide.trustScore.setSupervised', key: 'ctrl+shift+2', description: localize('vibeide.keyboard.trustScore.setSupervised', 'Установить Trust Score: Supervised 🟡') },
	{ command: 'vibeide.trustScore.setAuto', key: 'ctrl+shift+3', description: localize('vibeide.keyboard.trustScore.setAuto', 'Установить Trust Score: Auto 🔴') },

	// Tool approval
	{ command: 'vibeide.toolApproval.approve', key: 'enter', when: 'vibeide.toolApprovalPending', description: localize('vibeide.keyboard.toolApproval.approve', 'Подтвердить ожидающий вызов инструмента') },
	{ command: 'vibeide.toolApproval.reject', key: 'escape', when: 'vibeide.toolApprovalPending', description: localize('vibeide.keyboard.toolApproval.reject', 'Отклонить ожидающий вызов инструмента') },

	// Diff review
	{ command: 'vibeide.diff.apply', key: 'ctrl+enter', when: 'vibeide.diffPreviewOpen', description: localize('vibeide.keyboard.diff.apply', 'Применить diff') },
	{ command: 'vibeide.diff.reject', key: 'ctrl+backspace', when: 'vibeide.diffPreviewOpen', description: localize('vibeide.keyboard.diff.reject', 'Отклонить diff') },
	{ command: 'vibeide.diff.edit', key: 'ctrl+shift+e', when: 'vibeide.diffPreviewOpen', description: localize('vibeide.keyboard.diff.edit', 'Редактировать перед применением') },

	// Agent control
	{ command: 'vibeide.agent.pauseAndExplain', key: 'ctrl+shift+p', when: 'vibeide.agentRunning', description: localize('vibeide.keyboard.agent.pauseAndExplain', 'Приостановить агента и спросить, что он делает') },
	{ command: 'vibeide.agent.cancel', key: 'ctrl+shift+c', when: 'vibeide.agentRunning', description: localize('vibeide.keyboard.agent.cancel', 'Отменить задачу агента') },

	// Editor shortcuts
	{ command: 'vibeide.explainLine', key: 'ctrl+.', description: localize('vibeide.keyboard.explainLine', 'Объяснить текущую строку (инлайн)') },
	{ command: 'vibeide.freezeCode', key: 'ctrl+shift+f', when: 'editorHasSelection', description: localize('vibeide.keyboard.freezeCode', 'Заморозить выделенный код для агента') },

	// Pre-flight plan
	{ command: 'vibeide.preFlight.approve', key: 'enter', when: 'vibeide.preFlightPlanOpen', description: localize('vibeide.keyboard.preFlight.approve', 'Подтвердить предварительный план') },
	{ command: 'vibeide.preFlight.cancel', key: 'escape', when: 'vibeide.preFlightPlanOpen', description: localize('vibeide.keyboard.preFlight.cancel', 'Отменить предварительный план') },

	// Plan Mode
	{ command: 'vibeide.chatMode.plan', key: 'ctrl+shift+alt+p', description: localize('vibeide.keyboard.chatMode.plan', 'Переключить чат в режим Plan — исследование и планирование без изменений') },
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
	) {
		super();
		vibeLog.debug('Keyboard', `${VIBE_KEYBOARD_SHORTCUTS.length} shortcuts registered`);
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
				vibeLog.warn('Keyboard', `Conflict: ${vibe.key} (${vibe.command} vs ${conflict.command})`);
			}
		}
		return conflicts;
	}
}

registerSingleton(IVibeKeyboardShortcutsService, VibeKeyboardShortcutsService, InstantiationType.Eager);
