/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';
import { ALLOWED_TRANSITIONS, Task, TaskStatus } from '../common/taskLedger/taskModel.js';
import { IVibeTaskLedgerService } from './vibeTaskLedgerService.js';
import { planToTaskRequests } from '../common/taskLedger/planToTasks.js';
import { IChatThreadService } from './chatThreadService.js';
import type { PlanStep } from '../common/chatThreadServiceTypes.js';

/**
 * Команды реестра задач: завести работу, перевести её в другое состояние, проверить журнал.
 *
 * The register is a file; these are the ways a person touches it before a panel exists. Kept
 * deliberately small: creating, moving and verifying are the three things that cannot be done any
 * other way, and everything else is presentation.
 */

/** Human wording for a status. Shown in lists, so it is read rather than parsed. */
const STATUS_LABELS: Readonly<Record<TaskStatus, string>> = {
	inbox: localize('vibeide.tasks.status.inbox', 'входящие'),
	planned: localize('vibeide.tasks.status.planned', 'запланирована'),
	ready: localize('vibeide.tasks.status.ready', 'готова к работе'),
	running: localize('vibeide.tasks.status.running', 'в работе'),
	review: localize('vibeide.tasks.status.review', 'на проверке'),
	blocked: localize('vibeide.tasks.status.blocked', 'заблокирована'),
	done: localize('vibeide.tasks.status.done', 'сделана'),
	cancelled: localize('vibeide.tasks.status.cancelled', 'отменена'),
};

class VibeTaskCreateAction extends Action2 {

	static readonly ID = 'vibeide.tasks.create';

	constructor() {
		super({
			id: VibeTaskCreateAction.ID,
			title: localize2('vibeide.tasks.create', 'Завести задачу'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const ledger = accessor.get(IVibeTaskLedgerService);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const title = await quickInput.input({
			title: localize('vibeide.tasks.createTitle', 'Новая задача'),
			placeHolder: localize('vibeide.tasks.createPlaceholder', 'Что нужно сделать'),
		});
		if (!title?.trim()) {
			return;
		}

		const existing = await ledger.tasks();
		// Dependencies are optional and chosen from what exists: typing an id by hand would mostly
		// produce dependencies on tasks that are not there.
		const picked = existing.length > 0
			? await quickInput.pick(existing.map(task => taskItem(task)), {
				title: localize('vibeide.tasks.dependsOn', 'Чего ждёт эта задача? (Esc — ничего)'),
				canPickMany: true,
			})
			: undefined;

		const result = await ledger.create({
			title: title.trim(),
			dependencyIds: picked?.map(item => item.taskId) ?? [],
			actor: 'human',
		});
		if (result.ok) {
			notification.info(localize('vibeide.tasks.created', 'Задача заведена: {0}', result.task.title));
		} else {
			notification.error(result.error);
		}
	}
}

class VibeTaskMoveAction extends Action2 {

	static readonly ID = 'vibeide.tasks.move';

	constructor() {
		super({
			id: VibeTaskMoveAction.ID,
			title: localize2('vibeide.tasks.move', 'Реестр задач: перевести задачу'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const ledger = accessor.get(IVibeTaskLedgerService);
		const quickInput = accessor.get(IQuickInputService);
		const notification = accessor.get(INotificationService);

		const tasks = await ledger.tasks();
		if (tasks.length === 0) {
			notification.info(localize('vibeide.tasks.empty', 'Реестр задач пуст.'));
			return;
		}
		const chosen = await quickInput.pick(await Promise.all(tasks.map(async task => {
			const waiting = await ledger.waitingFor(task.id);
			return taskItem(task, waiting);
		})), { title: localize('vibeide.tasks.pick', 'Какую задачу переводим') });
		if (!chosen) {
			return;
		}
		const task = tasks.find(candidate => candidate.id === chosen.taskId)!;

		const allowed = [...(ALLOWED_TRANSITIONS.get(task.status) ?? [])];
		if (allowed.length === 0) {
			// Terminal on purpose: reopening is a new task with its own history.
			notification.info(localize('vibeide.tasks.terminal', 'Задача «{0}» уже {1} — это конечное состояние.', task.title, STATUS_LABELS[task.status]));
			return;
		}
		const target = await quickInput.pick(allowed.map(status => ({ label: STATUS_LABELS[status], status })), {
			title: localize('vibeide.tasks.pickStatus', 'Во что переводим «{0}»', task.title),
		});
		if (!target) {
			return;
		}

		let blockedReason: string | undefined;
		if (target.status === 'blocked') {
			// The reason is asked for once, here: «blocked» without it is a state nobody can act on.
			blockedReason = await quickInput.input({
				title: localize('vibeide.tasks.blockedReason', 'Что мешает?'),
				placeHolder: localize('vibeide.tasks.blockedReasonPlaceholder', 'Например: ждёт ключ API'),
			});
		}

		const result = await ledger.transition({ taskId: task.id, to: target.status, actor: 'human', blockedReason });
		if (result.ok) {
			notification.info(localize('vibeide.tasks.moved', '«{0}» — теперь {1}.', result.task.title, STATUS_LABELS[result.task.status]));
		} else {
			notification.error(result.error);
		}
	}
}

class VibeTaskVerifyAction extends Action2 {

	static readonly ID = 'vibeide.tasks.verify';

	constructor() {
		super({
			id: VibeTaskVerifyAction.ID,
			title: localize2('vibeide.tasks.verify', 'Проверить журнал задач'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const ledger = accessor.get(IVibeTaskLedgerService);
		const dialog = accessor.get(IDialogService);

		const verdict = await ledger.verify();
		const location = ledger.location();
		const lines = [verdict.detail];
		if (location) {
			lines.push('', localize('vibeide.tasks.location', 'Журнал: {0}', location.fsPath));
			lines.push(localize('vibeide.tasks.locationWhy', 'Он лежит вне рабочей папки — там, куда не дотягиваются файловые инструменты агента.'));
		}
		if (verdict.intact) {
			await dialog.info(localize('vibeide.tasks.verifyTitle', 'Журнал задач'), lines.join('\n'));
		} else {
			// A broken chain is evidence of an edit, not proof of malice — said in exactly those words.
			await dialog.prompt({
				type: Severity.Warning,
				message: localize('vibeide.tasks.verifyTitle', 'Журнал задач'),
				detail: [...lines, '', localize('vibeide.tasks.verifyBroken', 'Это признак правки файла, а не доказательство злого умысла: цепочка показывает, что запись изменилась, но не кто это сделал.')].join('\n'),
				buttons: [{ label: localize('vibeide.tasks.ok', 'Понятно'), run: () => undefined }],
			});
		}
	}
}

interface TaskPickItem extends IQuickPickItem {
	readonly taskId: string;
}

function taskItem(task: Task, waiting: readonly string[] = []): TaskPickItem {
	const parts = [STATUS_LABELS[task.status]];
	if (task.blockedReason) {
		parts.push(task.blockedReason);
	}
	if (waiting.length > 0) {
		// The count, not the ids: an id tells the reader nothing they can use at a glance.
		parts.push(localize('vibeide.tasks.waitingCount', 'ждёт: {0}', waiting.length));
	}
	return { label: task.title, description: parts.join(' · '), taskId: task.id };
}

class VibeTasksFromPlanAction extends Action2 {

	static readonly ID = 'vibeide.tasks.fromPlan';

	constructor() {
		super({
			id: VibeTasksFromPlanAction.ID,
			title: localize2('vibeide.tasks.fromPlan', 'Завести задачи из плана'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const ledger = accessor.get(IVibeTaskLedgerService);
		const threads = accessor.get(IChatThreadService);
		const notification = accessor.get(INotificationService);

		const thread = threads.state.allThreads[threads.state.currentThreadId];
		// The most recent plan in the thread: an older one has already been superseded, and carrying
		// over a plan the model itself abandoned would fill the register with retracted work.
		const planMessage = [...(thread?.messages ?? [])].reverse()
			.find(message => message.role === 'plan');
		const steps: PlanStep[] | undefined = planMessage && 'steps' in planMessage && Array.isArray(planMessage.steps)
			? planMessage.steps
			: undefined;
		if (!steps) {
			notification.info(localize('vibeide.tasks.noPlan', 'В этом чате нет плана, из которого можно завести задачи.'));
			return;
		}

		const requests = planToTaskRequests(steps);
		if (requests.length === 0) {
			// Said as a fact, not as a failure: a finished plan has nothing left to carry.
			notification.info(localize('vibeide.tasks.planDone', 'В плане нет незавершённых шагов — переносить нечего.'));
			return;
		}

		const idByStep = new Map<number, string>();
		let created = 0;
		for (const request of requests) {
			const result = await ledger.create({
				title: request.title,
				// Dependencies by position: a plan is a sequence, and losing that turns it into a pile.
				dependencyIds: request.afterStepNumbers.map(step => idByStep.get(step)).filter((id): id is string => !!id),
				actor: 'human',
			});
			if (result.ok) {
				idByStep.set(request.stepNumber, result.task.id);
				created++;
			} else {
				notification.error(result.error);
				break;
			}
		}
		if (created > 0) {
			notification.info(localize('vibeide.tasks.fromPlanDone', 'Заведено задач: {0}. Они ждут друг друга в том же порядке, что шаги плана.', created));
		}
	}
}

registerAction2(VibeTaskCreateAction);
registerAction2(VibeTasksFromPlanAction);
registerAction2(VibeTaskMoveAction);
registerAction2(VibeTaskVerifyAction);
