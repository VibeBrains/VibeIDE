/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * ACP со стороны окна: внешний агент становится виден IDE.
 *
 * Смысл этого файла — не проксирование, а ворота. Ради них протокол и брался: работа чужого
 * агента должна попадать в те же чекпоинты и тот же журнал, что работа собственного, иначе
 * откатить её нечем и увидеть её негде.
 *
 * Живой прогон с Claude Code показал, где именно эти ворота стоят. Клиентскую файловую систему
 * агент не вызывает — правит своими инструментами. Зато перед правкой он спрашивает разрешение и
 * присылает вместе с вопросом готовый дифф. Значит чекпоинт снимается ИМЕННО ТОГДА: файл ещё не
 * тронут, а список путей уже известен. Снимать после ответа агента было бы поздно.
 */

import { localize } from '../../../../../nls.js';
import { Disposable, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ProxyChannel } from '../../../../../base/parts/ipc/common/ipc.js';
import { Event } from '../../../../../base/common/event.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { IMainProcessService } from '../../../../../platform/ipc/common/mainProcessService.js';
import { INotificationService, Severity } from '../../../../../platform/notification/common/notification.js';
import { AcpEvent, IAcpAgentLaunch, IAcpPermissionRequest, IAcpSession, IVibeAcpMain, VIBE_ACP_CHANNEL } from '../../common/acp/acpTypes.js';
import { AcpStopReason, AcpToolStatus, IAcpAuthMethod, IAcpDiff } from '../../common/acp/acpProtocol.js';
import { AcpToolCallTracker } from '../../common/acp/acpToolCallTracker.js';
import { IVibeAcpService } from '../../common/acp/vibeAcpService.js';
import { IRollbackSnapshotService } from '../../common/rollbackSnapshotService.js';
import { IVibeAgentActivityLogService } from '../../browser/vibeAgentActivityLogService.js';

export class VibeAcpService extends Disposable implements IVibeAcpService {
	declare readonly _serviceBrand: undefined;

	private readonly _proxy: IVibeAcpMain;
	readonly onEvent: Event<AcpEvent>;

	/** Незавершённые вызовы инструментов: копим по ним «было → стало» до конца вызова. */
	private readonly _toolCalls = new AcpToolCallTracker();

	constructor(
		@IMainProcessService mainProcessService: IMainProcessService,
		@INotificationService private readonly _notificationService: INotificationService,
		@IRollbackSnapshotService private readonly _snapshotService: IRollbackSnapshotService,
		@IVibeAgentActivityLogService private readonly _activityLog: IVibeAgentActivityLogService,
	) {
		super();
		this._proxy = ProxyChannel.toService<IVibeAcpMain>(mainProcessService.getChannel(VIBE_ACP_CHANNEL));
		this.onEvent = this._proxy.onEvent;
		this._register(this.onEvent(event => this._observe(event)));
	}

	startSession(launch: IAcpAgentLaunch): Promise<IAcpSession> {
		return this._proxy.startSession(launch);
	}

	prompt(sessionId: string, text: string): Promise<AcpStopReason> {
		return this._proxy.prompt(sessionId, text);
	}

	answerPermission(requestId: string, optionId: string | undefined): Promise<void> {
		return this._proxy.answerPermission(requestId, optionId);
	}

	cancel(sessionId: string): Promise<void> {
		return this._proxy.cancel(sessionId);
	}

	endSession(sessionId: string): Promise<void> {
		return this._proxy.endSession(sessionId);
	}

	// ── Ворота ───────────────────────────────────────────────────────────────

	private _observe(event: AcpEvent): void {
		switch (event.kind) {
			case 'permission':
				void this._guard(event.request);
				return;
			case 'tool':
				this._trackTool(event.toolCallId, event.title, event.status, event.diffs);
				return;
			case 'wrote':
				this._activityLog.logFinished(localize('vibeide.acp.log.wrote', "Внешний агент записал файл нашими руками: {0}", event.path));
				return;
			case 'authRequired':
				this._reportAuthRequired(event.agentName, event.methods);
				return;
			case 'done':
			case 'failed':
				this._toolCalls.reset();
				if (event.kind === 'failed') {
					this._activityLog.logError(localize('vibeide.acp.log.failed', "Связь с внешним агентом оборвалась: {0}", event.error));
				}
				return;
		}
	}

	/** Кадр вызова инструмента: пишем в журнал по завершении, из накопленного трекером. */
	private _trackTool(toolCallId: string, title: string, status: AcpToolStatus, diffs: readonly IAcpDiff[]): void {
		const finished = this._toolCalls.accept(toolCallId, title, status, diffs);
		if (!finished || finished.diffs.length === 0) { return; }
		if (finished.failed) {
			this._activityLog.logError(localize('vibeide.acp.log.editFailed', "Правка внешнего агента не удалась: {0}", describeEdits(finished.title, finished.diffs)));
		} else {
			this._activityLog.logFinished(describeEdits(finished.title, finished.diffs));
		}
	}

	/**
	 * Вопрос человеку — и чекпоинт до ответа.
	 *
	 * Снимок делается ДО показа вопроса, а не после согласия: между «да» и правкой агента нет
	 * места, куда его можно было бы вставить. Отказ снимок отбрасывает — копить точки отката,
	 * которым не соответствовало ни одной правки, значит завалить историю пустышками.
	 */
	private async _guard(request: IAcpPermissionRequest): Promise<void> {
		const snapshotId = await this._snapshotBefore(request);
		this._activityLog.logStarted(localize('vibeide.acp.log.asks', "Внешний агент просит разрешения: {0}", request.title));

		const chosen = await this._ask(request);
		await this._proxy.answerPermission(request.requestId, chosen);

		if (!chosen && snapshotId) {
			await this._snapshotService.discardSnapshot(snapshotId);
		}
	}

	private async _snapshotBefore(request: IAcpPermissionRequest): Promise<string | undefined> {
		if (request.paths.length === 0 || !this._snapshotService.isEnabled()) { return undefined; }
		try {
			const snapshot = await this._snapshotService.createSnapshot([...request.paths]);
			return snapshot.id;
		} catch (err) {
			// Не снятый чекпоинт — повод предупредить, а не повод не спросить разрешения: без
			// вопроса агент встанет навсегда.
			this._activityLog.logError(localize('vibeide.acp.log.noSnapshot', "Чекпоинт перед правкой внешнего агента не снят: {0}", err instanceof Error ? err.message : String(err)));
			return undefined;
		}
	}

	/** Ответ человека. `undefined` — отказ: закрытое без выбора уведомление значит «нет». */
	private _ask(request: IAcpPermissionRequest): Promise<string | undefined> {
		return new Promise<string | undefined>(resolve => {
			const store = new DisposableStore();
			let settled = false;
			const settle = (optionId: string | undefined) => {
				if (settled) { return; }
				settled = true;
				store.dispose();
				resolve(optionId);
			};
			const handle = this._notificationService.prompt(
				Severity.Info,
				`${request.title}\n${request.detail}`,
				request.options.map(option => ({ label: option.name, run: () => settle(option.optionId) })),
				{ sticky: true, onCancel: () => settle(undefined) },
			);
			store.add(handle.onDidClose(() => settle(undefined)));
		});
	}

	private _reportAuthRequired(agentName: string, methods: readonly IAcpAuthMethod[]): void {
		// Голый код ошибки не говорит, что делать. Способ входа агент назвал сам при знакомстве —
		// его и показываем.
		const how = methods.map(method => method.description || method.name).join('; ');
		this._notificationService.error(how
			? localize('vibeide.acp.auth.withMethods', "Агент «{0}» не авторизован. Как войти: {1}", agentName, how)
			: localize('vibeide.acp.auth.bare', "Агент «{0}» не авторизован, и способов входа он не назвал.", agentName));
	}
}

/** Строка журнала о правке: что за инструмент и сколько строк в каком файле изменилось. */
function describeEdits(title: string, diffs: readonly IAcpDiff[]): string {
	const parts = diffs.map(diff => localize(
		'vibeide.acp.log.editEntry',
		"{0}: −{1}/+{2} строк",
		diff.path,
		countLines(diff.oldText),
		countLines(diff.newText)));
	return localize('vibeide.acp.log.edited', "Правка внешнего агента ({0}) — {1}", title || localize('vibeide.acp.log.unnamedTool', "инструмент без названия"), parts.join('; '));
}

/** Пустой текст — это ноль строк: так выглядит создание файла и удаление содержимого. */
const countLines = (text: string): number => (text ? text.split('\n').length : 0);

registerSingleton(IVibeAcpService, VibeAcpService, InstantiationType.Delayed);
