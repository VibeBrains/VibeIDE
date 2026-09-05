/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as DOM from '../../../../base/browser/dom.js';
import { $ } from '../../../../base/browser/dom.js';
import { localize } from '../../../../nls.js';
import { IViewPaneOptions, ViewPane } from '../../../browser/parts/views/viewPane.js';
import { IViewDescriptorService } from '../../../common/views.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IContextKeyService } from '../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IHoverService } from '../../../../platform/hover/browser/hover.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IKeybindingService } from '../../../../platform/keybinding/common/keybinding.js';
import { IOpenerService } from '../../../../platform/opener/common/opener.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { DisposableStore } from '../../../../base/common/lifecycle.js';
import { ALLOWED_TRANSITIONS, Task, TaskStatus } from '../common/taskLedger/taskModel.js';
import { IVibeTaskLedgerService } from './vibeTaskLedgerService.js';

/**
 * Доска реестра задач.
 *
 * The palette commands can already do everything; a board is worth having anyway, because work you
 * see without asking for it is work you actually track. Grouped by state rather than listed flat:
 * «what is in progress» and «what is stuck» are the two questions a board is opened with.
 */

/** Column order. Terminal states last: they are history, and history does not need the top row. */
const COLUMN_ORDER: readonly TaskStatus[] = ['running', 'review', 'ready', 'blocked', 'planned', 'inbox', 'done', 'cancelled'];

const COLUMN_TITLES: Readonly<Record<TaskStatus, string>> = {
	running: localize('vibeide.tasksView.running', 'В работе'),
	review: localize('vibeide.tasksView.review', 'На проверке'),
	ready: localize('vibeide.tasksView.ready', 'Готовы к работе'),
	blocked: localize('vibeide.tasksView.blocked', 'Заблокированы'),
	planned: localize('vibeide.tasksView.planned', 'Запланированы'),
	inbox: localize('vibeide.tasksView.inbox', 'Входящие'),
	done: localize('vibeide.tasksView.done', 'Сделаны'),
	cancelled: localize('vibeide.tasksView.cancelled', 'Отменены'),
};

export class VibeTasksViewPane extends ViewPane {

	private _body: HTMLElement | undefined;
	/**
	 * Listeners of the rows currently drawn.
	 *
	 * Cleared on every redraw: registering them on the pane instead would pile up a set per render,
	 * and the board redraws on every change to the register.
	 */
	private readonly _rowListeners = this._register(new DisposableStore());

	constructor(
		options: IViewPaneOptions,
		@IKeybindingService keybindingService: IKeybindingService,
		@IContextMenuService contextMenuService: IContextMenuService,
		@IConfigurationService configurationService: IConfigurationService,
		@IContextKeyService contextKeyService: IContextKeyService,
		@IViewDescriptorService viewDescriptorService: IViewDescriptorService,
		@IInstantiationService instantiationService: IInstantiationService,
		@IOpenerService openerService: IOpenerService,
		@IThemeService themeService: IThemeService,
		@IHoverService hoverService: IHoverService,
		@IVibeTaskLedgerService private readonly _ledger: IVibeTaskLedgerService,
		@IQuickInputService private readonly _quickInput: IQuickInputService,
		@INotificationService private readonly _notification: INotificationService,
	) {
		super(options, keybindingService, contextMenuService, configurationService, contextKeyService,
			viewDescriptorService, instantiationService, openerService, themeService, hoverService);

		// The register is written from three places — the palette, the agent, this board — so the
		// board follows the ledger rather than its own actions.
		this._register(this._ledger.onDidChange(() => this._render()));
	}

	protected override renderBody(container: HTMLElement): void {
		super.renderBody(container);
		this._body = DOM.append(container, $('.vibe-tasks-view'));
		void this._render();
	}

	private async _render(): Promise<void> {
		const body = this._body;
		if (!body) {
			return;
		}
		const tasks = await this._ledger.tasks();
		this._rowListeners.clear();
		DOM.clearNode(body);

		if (tasks.length === 0) {
			const empty = DOM.append(body, $('.vibe-tasks-empty'));
			// Says how to start, not just that there is nothing: an empty board with no way forward is
			// a dead end.
			empty.textContent = localize('vibeide.tasksView.empty', 'Задач пока нет. Команда «VibeIDE: Завести задачу» добавит первую — или попросите об этом агента.');
			return;
		}

		const byStatus = new Map<TaskStatus, Task[]>();
		for (const task of tasks) {
			const list = byStatus.get(task.status);
			if (list) { list.push(task); } else { byStatus.set(task.status, [task]); }
		}

		for (const status of COLUMN_ORDER) {
			const column = byStatus.get(status);
			if (!column?.length) {
				// Empty states are not drawn: eight headings over four tasks is a form, not a board.
				continue;
			}
			const section = DOM.append(body, $('.vibe-tasks-section'));
			const heading = DOM.append(section, $('.vibe-tasks-heading'));
			heading.textContent = `${COLUMN_TITLES[status]} · ${column.length}`;
			for (const task of column) {
				await this._renderTask(section, task);
			}
		}
	}

	private async _renderTask(parent: HTMLElement, task: Task): Promise<void> {
		const row = DOM.append(parent, $('.vibe-tasks-row'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const title = DOM.append(row, $('.vibe-tasks-title'));
		title.textContent = task.title;

		const waiting = await this._ledger.waitingFor(task.id);
		if (waiting.length > 0 || task.blockedReason) {
			const note = DOM.append(row, $('.vibe-tasks-note'));
			// What it waits for, in words the reader can act on — a count answers nothing.
			note.textContent = task.blockedReason
				?? localize('vibeide.tasksView.waiting', 'ждёт: {0}', waiting.length);
		}

		const open = () => this._move(task);
		this._rowListeners.add(DOM.addDisposableListener(row, DOM.EventType.CLICK, open));
		this._rowListeners.add(DOM.addDisposableListener(row, DOM.EventType.KEY_DOWN, (event: KeyboardEvent) => {
			if (event.key === 'Enter' || event.key === ' ') {
				event.preventDefault();
				open();
			}
		}));
	}

	private async _move(task: Task): Promise<void> {
		const allowed = [...(ALLOWED_TRANSITIONS.get(task.status) ?? [])];
		if (allowed.length === 0) {
			this._notification.info(localize('vibeide.tasksView.terminal', '«{0}» — конечное состояние, переводить некуда.', task.title));
			return;
		}
		const target = await this._quickInput.pick(allowed.map(status => ({ label: COLUMN_TITLES[status], status })), {
			title: localize('vibeide.tasksView.moveTitle', 'Куда переводим «{0}»', task.title),
		});
		if (!target) {
			return;
		}
		let blockedReason: string | undefined;
		if (target.status === 'blocked') {
			blockedReason = await this._quickInput.input({
				title: localize('vibeide.tasksView.blockedReason', 'Что мешает?'),
			});
		}
		const result = await this._ledger.transition({ taskId: task.id, to: target.status, actor: 'human', blockedReason });
		if (!result.ok) {
			// The refusal carries its own wording — the register knows why better than the board does.
			this._notification.error(result.error);
		}
	}
}
