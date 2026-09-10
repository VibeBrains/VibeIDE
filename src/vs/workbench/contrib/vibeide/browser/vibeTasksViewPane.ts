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
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { Action2, MenuId, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IViewsService } from '../../../services/views/common/viewsService.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { localize2 } from '../../../../nls.js';
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

/**
 * Идентификатор доски.
 *
 * Declared here, not in the contribution that registers it: the title actions need it, the
 * contribution needs the pane — and importing the contribution back would close the ring. The
 * compiler allows such a cycle; the bundler does not, which is how this was caught.
 */
export const VIBE_TASKS_VIEW_ID = 'workbench.view.vibeTasks.board';

/** Per workspace: one project's board settles differently from another's. */
const SHOW_FINISHED_KEY = 'vibeide.tasksView.showFinished';

const FINISHED: ReadonlySet<TaskStatus> = new Set<TaskStatus>(['done', 'cancelled']);

export class VibeTasksViewPane extends ViewPane {

	private _body: HTMLElement | undefined;
	/**
	 * Listeners of the rows currently drawn.
	 *
	 * Cleared on every redraw: registering them on the pane instead would pile up a set per render,
	 * and the board redraws on every change to the register.
	 */
	private readonly _rowListeners = this._register(new DisposableStore());

	/**
	 * Показывать ли законченное.
	 *
	 * Off by default and remembered: a board that accumulates every finished task stops answering
	 * «что сейчас в работе», which is the question it is opened with. The history is not deleted —
	 * it is one toggle away.
	 */
	private get _showFinished(): boolean {
		return this._storage.getBoolean(SHOW_FINISHED_KEY, StorageScope.WORKSPACE, false);
	}

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
		@IStorageService private readonly _storage: IStorageService,
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
		const all = await this._ledger.tasks();
		const tasks = this._showFinished ? all : all.filter(task => !FINISHED.has(task.status));
		// Titles by id: the board says what a task waits FOR, and an id is not something a reader can
		// act on. The register answers in ids because that is what it stores; the naming happens here.
		const titleById = new Map(all.map(task => [task.id, task.title]));
		// Everything the rows need, fetched at once. Asking per row meant a hundred tasks were a
		// hundred waits in a row, each for an answer the register already had in memory.
		// Only for tasks that can still be waiting: a finished task waits for nothing, and asking about
		// it is a question with a known answer.
		const waitingByTask = new Map(await Promise.all(
			tasks
				.filter(task => task.status !== 'done' && task.status !== 'cancelled')
				.map(async task => [task.id, await this._ledger.waitingFor(task.id)] as const),
		));
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
				this._renderTask(section, task, waitingByTask.get(task.id) ?? [], titleById);
			}
		}
	}

	private _renderTask(parent: HTMLElement, task: Task, waiting: readonly string[], titleById: ReadonlyMap<string, string>): void {
		const row = DOM.append(parent, $('.vibe-tasks-row'));
		row.tabIndex = 0;
		row.setAttribute('role', 'button');

		const title = DOM.append(row, $('.vibe-tasks-title'));
		title.textContent = task.title;

		if (waiting.length > 0 || task.blockedReason) {
			const note = DOM.append(row, $('.vibe-tasks-note'));
			// What it waits for, by name: «ждёт: 2» tells the reader nothing they can act on, while
			// «ждёт: Собрать релиз» names the next thing to finish. Two names, then a count for the
			// rest — a row is one line, not a list.
			note.textContent = task.blockedReason ?? waitingLabel(waiting, titleById);
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

	/** Redraws on demand — used by the title actions, which change what the board shows. */
	refresh(): void {
		void this._render();
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

/** «ждёт: Собрать релиз, Проверить ключи и ещё 3» — имена, потом остаток числом. */
function waitingLabel(waiting: readonly string[], titleById: ReadonlyMap<string, string>): string {
	const named = waiting.map(id => titleById.get(id) ?? id);
	const shown = named.slice(0, 2).join(', ');
	return named.length <= 2
		? localize('vibeide.tasksView.waitingNamed', 'ждёт: {0}', shown)
		: localize('vibeide.tasksView.waitingMore', 'ждёт: {0} и ещё {1}', shown, named.length - 2);
}

/**
 * Действия в заголовке доски.
 *
 * Both duplicate something the palette can already do — and both belong here anyway: the palette is
 * where one goes knowing the name of the command, the title bar is where one looks while already
 * staring at the board.
 */
class VibeTasksCreateInViewAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.tasksView.create',
			title: localize2('vibeide.tasksView.createAction', 'Завести задачу'),
			icon: Codicon.add,
			// Only in the board's title bar: the palette already has «VibeIDE: Завести задачу», and two
			// identical names there would make the reader choose between things that do the same.
			f1: false,
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIBE_TASKS_VIEW_ID), group: 'navigation', order: 1 }],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		// Reuses the palette command instead of repeating its dialogue: two ways of creating a task
		// would drift, and the one that drifts is always the one nobody tests.
		await accessor.get(ICommandService).executeCommand('vibeide.tasks.create');
	}
}

class VibeTasksToggleFinishedAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.tasksView.toggleFinished',
			title: localize2('vibeide.tasksView.toggleFinishedAction', 'Показывать завершённые'),
			icon: Codicon.history,
			// A view-local toggle: outside the board it has nothing to toggle.
			f1: false,
			toggled: ContextKeyExpr.true(),
			menu: [{ id: MenuId.ViewTitle, when: ContextKeyExpr.equals('view', VIBE_TASKS_VIEW_ID), group: 'navigation', order: 2 }],
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const storage = accessor.get(IStorageService);
		const next = !storage.getBoolean(SHOW_FINISHED_KEY, StorageScope.WORKSPACE, false);
		storage.store(SHOW_FINISHED_KEY, next, StorageScope.WORKSPACE, StorageTarget.USER);
		// The board redraws itself: the toggle changes what is shown, not what is stored in the ledger.
		const view = accessor.get(IViewsService).getViewWithId(VIBE_TASKS_VIEW_ID);
		if (view instanceof VibeTasksViewPane) {
			view.refresh();
		}
	}
}

registerAction2(VibeTasksCreateInViewAction);
registerAction2(VibeTasksToggleFinishedAction);
