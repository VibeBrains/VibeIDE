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
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

const MODE_ORDER: ChatMode[] = ['agent', 'gather', 'plan', 'normal'];

// Mirrors the mode names in the chat dropdown (vibeSettingsRu.ts) — single terminology.
const MODE_LABEL: Record<ChatMode, string> = {
	agent: 'Агент',
	gather: 'Обзор',
	plan: 'План',
	normal: 'Чат',
};

const MODE_ICON: Record<ChatMode, string> = {
	agent: '$(rocket)',
	gather: '$(search)',
	plan: '$(checklist)',
	normal: '$(comment-discussion)',
};

const MODE_TOOLTIP: Record<ChatMode, string> = {
	agent: 'Агент — выполняет инструменты и правит файлы, с учётом Trust Score и ограничений.',
	gather: 'Обзор — исследование кодовой базы, только чтение, без записи.',
	plan: 'План — исследование и Markdown-план, без изменений в коде.',
	normal: 'Чат — обычный вопрос-ответ, без инструментов.',
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

	private _rowLabel(): string {
		const mode = this._settingsService.state.globalSettings.chatMode;
		return `${MODE_ICON[mode]} ${MODE_LABEL[mode]}`;
	}

	private _tooltip(): string {
		const mode = this._settingsService.state.globalSettings.chatMode;
		return MODE_TOOLTIP[mode];
	}

	private _entryProps(): IStatusbarEntry {
		const mode = this._settingsService.state.globalSettings.chatMode;
		const label = MODE_LABEL[mode];
		const icon = MODE_ICON[mode];
		return {
			name: localize('vibeideChatModeSbName', 'VibeIDE режим чата'),
			text: `${icon} ${label}`,
			ariaLabel: localize('vibeideChatModeSbAria', 'Режим чата: {0}. Нажмите для переключения.', label),
			tooltip: MODE_TOOLTIP[mode] + '\n\n' + localize('vibeideChatModeSbCycle', 'Нажмите для перебора: Agent → Explore → Plan → Chat.'),
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
