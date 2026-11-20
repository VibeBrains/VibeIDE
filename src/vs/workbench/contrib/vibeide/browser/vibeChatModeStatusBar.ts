/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { ChatMode } from '../common/vibeideSettingsTypes.js';
import { ChatModeChoice, chatModeChoiceOf } from '../common/chatPermissionMode.js';
import { CHAT_MODE_CHOICE_DETAIL, CHAT_MODE_CHOICE_LABEL } from '../common/chatModeChoiceLabels.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

const MODE_ORDER: ChatMode[] = ['agent', 'gather', 'plan', 'normal'];

// Имена и описания — из общего списка «Режим»: статус-бар не заводит своих слов для тех же режимов
const CHOICE_ICON: Record<ChatModeChoice, string> = {
	normal: '$(comment-discussion)',
	gather: '$(search)',
	plan: '$(checklist)',
	manual: '$(account)',
	edits: '$(edit)',
	auto: '$(rocket)',
	bypass: '$(zap)',
};

const CYCLE_COMMAND = 'vibeide.chat.cycleMode';

CommandsRegistry.registerCommand(CYCLE_COMMAND, async accessor => {
	const settingsService = accessor.get(IVibeideSettingsService);
	const current = settingsService.state.globalSettings.chatMode;
	const idx = MODE_ORDER.indexOf(current);
	const next = MODE_ORDER[(idx + 1) % MODE_ORDER.length];
	await settingsService.setGlobalSetting('chatMode', next);
});

/**
 * Status-bar indicator for the active chat mode (Agent / Explore / Plan / Chat).
 * Click cycles modes; the same command is bindable as a keyboard shortcut.
 */
export class VibeChatModeStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeChatModeStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._register(this._settingsService.onDidChangeState(() => this._refresh()));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _wire(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.chat.mode',
				label: this._rowLabel(),
				tooltip: this._tooltip(),
				priority: 174,
				command: CYCLE_COMMAND,
			});
		} else {
			this._entry = this._statusbarService.addEntry(
				this._entryProps(),
				'vibeide.chat.mode',
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 174 }, alignment: StatusbarAlignment.RIGHT }
			);
		}
	}

	private _refresh(): void {
		if (this._entry) { this._entry.update(this._entryProps()); }
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.chat.mode', { label: this._rowLabel(), tooltip: this._tooltip() });
		}
	}

	/** Текущий пункт списка «Режим»: у агента это режим разрешений, у остальных — сам режим чата */
	private _choice(): ChatModeChoice {
		const globals = this._settingsService.state.globalSettings;
		return chatModeChoiceOf(globals.chatMode, globals.chatPermissionMode);
	}

	/** Что переберёт щелчок: режимы чата по кругу, имя агентского пункта — выбранный режим разрешений */
	private _cycleHint(): string {
		const permissionMode = this._settingsService.state.globalSettings.chatPermissionMode;
		return MODE_ORDER.map(mode => CHAT_MODE_CHOICE_LABEL[chatModeChoiceOf(mode, permissionMode)]).join(' → ');
	}

	private _rowLabel(): string {
		const choice = this._choice();
		return `${CHOICE_ICON[choice]} ${CHAT_MODE_CHOICE_LABEL[choice]}`;
	}

	private _tooltip(): string {
		const choice = this._choice();
		return `${CHAT_MODE_CHOICE_LABEL[choice]} — ${CHAT_MODE_CHOICE_DETAIL[choice]}`
			+ '\n\n' + localize('vibeideChatModeSbCycle', 'Нажмите для перебора: {0}. Режим разрешений щелчок не меняет.', this._cycleHint());
	}

	private _entryProps(): IStatusbarEntry {
		const choice = this._choice();
		const label = CHAT_MODE_CHOICE_LABEL[choice];
		const icon = CHOICE_ICON[choice];
		return {
			name: localize('vibeideChatModeSbName', 'VibeIDE режим чата'),
			text: `${icon} ${label}`,
			ariaLabel: localize('vibeideChatModeSbAria', 'Режим: {0}. Нажмите для переключения.', label),
			tooltip: this._tooltip(),
			command: CYCLE_COMMAND,
		};
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeChatModeStatusBarContribution.ID,
	VibeChatModeStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
