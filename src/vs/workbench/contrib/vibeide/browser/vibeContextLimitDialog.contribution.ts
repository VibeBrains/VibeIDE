/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IChatThreadService } from './chatThreadService.js';
import { ContextLimitAction, ContextLimitEvent, IVibeContextGuardService } from './vibeContextGuardService.js';
import { ContextLimitDialogGate, DEFAULT_PRESERVE_NOTE } from '../common/contextLimitDialog.js';

const DIALOG_ENABLED_SETTING = 'vibeide.context.criticalDialog.enabled';
const CRITICAL_THRESHOLD_SETTING = 'vibeide.context.criticalThresholdPercent';

interface IContextLimitPickItem extends IQuickPickItem {
	readonly choice: ContextLimitAction;
}

/**
 * Диалог на критическом заполнении контекста: «Сжать / Продолжить / Остановить»
 *
 * Сжатие выполняет budget-fill при следующем запросе, поэтому «Сжать» здесь
 * сохраняет заметку и оставляет флаг, а не переписывает историю сам
 */
export class VibeContextLimitDialogContribution extends Disposable implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.vibeContextLimitDialog';

	private readonly _gate = new ContextLimitDialogGate();
	private _dialogOpen = false;
	private _lastThreadId: string | undefined;

	constructor(
		@IVibeContextGuardService private readonly _contextGuard: IVibeContextGuardService,
		@IChatThreadService private readonly _chatThreads: IChatThreadService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@IConfigurationService private readonly _configuration: IConfigurationService,
	) {
		super();
		this._lastThreadId = this._chatThreads.state.currentThreadId;
		this._register(this._contextGuard.onContextLimitCritical(event => { void this._showDialog(event); }));
		// Событие треда срабатывает на каждое изменение состояния, поэтому сравниваем id:
		// сброс «одного раза» нужен только на настоящей смене треда, как и reset() гарда
		this._register(this._chatThreads.onDidChangeCurrentThread(() => {
			const currentThreadId = this._chatThreads.state.currentThreadId;
			if (currentThreadId !== this._lastThreadId) {
				this._lastThreadId = currentThreadId;
				this._gate.reset();
			}
		}));
	}

	private async _showDialog(event: ContextLimitEvent): Promise<void> {
		// Пока диалог открыт, второй critical не должен ставить окно поверх окна
		if (this._dialogOpen) {
			return;
		}
		const enabled = this._configuration.getValue<boolean>(DIALOG_ENABLED_SETTING) !== false;
		const criticalThresholdPercent = this._configuration.getValue<number>(CRITICAL_THRESHOLD_SETTING) ?? 90;
		const threadId = this._chatThreads.state.currentThreadId;
		if (!this._gate.shouldShow({ enabled, threadId, percentUsed: event.status.percentUsed, criticalThresholdPercent })) {
			return;
		}
		this._gate.markShown(threadId);
		this._dialogOpen = true;
		try {
			await this._askAndApply(event.status.percentUsed);
		} finally {
			this._dialogOpen = false;
		}
	}

	private async _askAndApply(percentUsed: number): Promise<void> {
		const percent = Math.round(percentUsed);
		const items: IContextLimitPickItem[] = [
			{
				label: localize('vibeide.context.dialog.compact', 'Сжать историю'),
				description: localize('vibeide.context.dialog.compactDescription', 'свернуть старую часть в сводку и сохранить заметку'),
				choice: 'compact',
			},
			{
				label: localize('vibeide.context.dialog.continue', 'Продолжить'),
				description: localize('vibeide.context.dialog.continueDescription', 'без сжатия — следующий запрос может упереться в лимит'),
				choice: 'continue',
			},
			{
				label: localize('vibeide.context.dialog.cancel', 'Остановить'),
				description: localize('vibeide.context.dialog.cancelDescription', 'поставить агента на паузу, прогресс сохранится'),
				choice: 'cancel',
			},
		];
		const picked = await this._quickInput.pick(items, {
			title: localize('vibeide.context.dialog.title', 'Контекстное окно заполнено на {0}%', percent),
			placeHolder: localize('vibeide.context.dialog.placeHolder', 'Что сделать перед следующим запросом?'),
		});
		if (!picked) {
			return;
		}
		if (picked.choice === 'compact') {
			await this._compactWithNote();
			return;
		}
		if (picked.choice === 'cancel') {
			// Тред берём в момент действия: за время диалога пользователь мог переключиться
			const threadId = this._chatThreads.state.currentThreadId;
			await this._chatThreads.pauseAgentExecution({ threadId });
		}
	}

	private async _compactWithNote(): Promise<void> {
		const note = await this._quickInput.input({
			title: localize('vibeide.context.dialog.compactTitle', 'Сжать историю'),
			prompt: localize('vibeide.context.dialog.notePrompt', 'Что сохранить после сжатия'),
			placeHolder: localize('vibeide.context.dialog.notePlaceHolder', 'Решения, открытые вопросы, что выбросить'),
			value: this._contextGuard.getPreserveNote() ?? DEFAULT_PRESERVE_NOTE,
		});
		// Отмена поля отменяет и сжатие: молча сжимать без подтверждения нельзя
		if (note === undefined) {
			return;
		}
		this._contextGuard.setPreserveNote(note.trim() || undefined);
		this._contextGuard.requestForceCompact();
	}
}

registerWorkbenchContribution2(VibeContextLimitDialogContribution.ID, VibeContextLimitDialogContribution, WorkbenchPhase.AfterRestored);
