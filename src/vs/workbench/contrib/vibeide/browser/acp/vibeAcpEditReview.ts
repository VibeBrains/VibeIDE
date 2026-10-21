/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Правки внешнего агента в общем ревью: панель «N файлов с изменениями», принять и отклонить по файлу и по всем
 *
 * Claude Code пишет файлы сам, мимо редактора, поэтому у его правок не было ни зон разбора, ни отката
 * Здесь вызов-правка, дошедший до `completed`, ставится на разбор так же, как правка встроенного агента:
 * зона файла получает прежний текст как исходный, а текст на диске остаётся тем, что записал агент
 * «Принять» оставляет записанное, «Отклонить» возвращает файл к состоянию на начало хода
 * Файл, которого до хода не было, при отклонении убирается — иначе от него остался бы пустой файл
 *
 * Откуда берётся прежний текст и когда ему нельзя верить — в `common/acp/acpEditBaseline.ts`
 * Слой этот только исполняет решение: читает диск, подтягивает модель редактора и заводит зону
 */

import { localize } from '../../../../../nls.js';
import { Disposable } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { createDecorator } from '../../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../../platform/instantiation/common/extensions.js';
import { FileSystemProviderCapabilities, IFileService } from '../../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../../platform/workspace/common/workspace.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { AcpToolStatus, IAcpDiff } from '../../common/acp/acpProtocol.js';
import { ACP_EDIT_TOOL_KIND, AcpEditLedger, AcpFileBefore, resolveBaseline } from '../../common/acp/acpEditBaseline.js';
import { IVibeideModelService } from '../../common/vibeideModelService.js';
import { IEditCodeService } from '../editCodeServiceInterface.js';
import { IVibeAgentActivityLogService } from '../vibeAgentActivityLogService.js';

export const IVibeAcpEditReviewService = createDecorator<IVibeAcpEditReviewService>('vibeAcpEditReviewService');

/** Вызов инструмента внешнего агента, как его накопила лента сессии */
export interface IVibeAcpEditCall {
	readonly toolKind: string;
	readonly status: AcpToolStatus;
	readonly paths: readonly string[];
	readonly diffs: readonly IAcpDiff[];
}

export interface IVibeAcpEditReviewService {
	readonly _serviceBrand: undefined;

	/** Начался ход: первое касание файла снова задаёт для него прежний текст */
	beginTurn(sessionId: string): void;
	/** Файлы, снятые главным процессом до правки */
	remember(sessionId: string, files: readonly AcpFileBefore[]): void;
	/** Вызов закончился: если это правка файлов, она ставится на разбор */
	settle(sessionId: string, call: IVibeAcpEditCall): Promise<void>;
	/** Агент записал файл через нас (`fs/write_text_file`): диффа нет, есть только снятый до записи текст */
	settleWritten(sessionId: string, path: string): Promise<void>;
	/** Сессия закончилась: снятые для неё тексты больше не нужны */
	forget(sessionId: string): void;
}

export class VibeAcpEditReviewService extends Disposable implements IVibeAcpEditReviewService {
	declare readonly _serviceBrand: undefined;

	private readonly _ledgers = new Map<string, AcpEditLedger>();
	/** Правки ставятся на разбор по одной: две подряд на один файл иначе читали бы диск вперемешку */
	private _queue: Promise<void> = Promise.resolve();

	constructor(
		@IEditCodeService private readonly _editCode: IEditCodeService,
		@ITextFileService private readonly _textFiles: ITextFileService,
		@IVibeideModelService private readonly _models: IVibeideModelService,
		@IFileService private readonly _files: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeAgentActivityLogService private readonly _activityLog: IVibeAgentActivityLogService,
	) {
		super();
	}

	beginTurn(sessionId: string): void {
		this._ledgerOf(sessionId).clear();
	}

	remember(sessionId: string, files: readonly AcpFileBefore[]): void {
		this._ledgerOf(sessionId).remember(files);
	}

	settle(sessionId: string, call: IVibeAcpEditCall): Promise<void> {
		if (call.toolKind !== ACP_EDIT_TOOL_KIND || call.status !== 'completed') { return Promise.resolve(); }
		return this._enqueue(async () => {
			for (const path of call.paths) {
				await this._review(sessionId, path, call.diffs.find(diff => diff.path === path));
			}
		});
	}

	settleWritten(sessionId: string, path: string): Promise<void> {
		return this._enqueue(() => this._review(sessionId, path, undefined));
	}

	forget(sessionId: string): void {
		this._ledgers.delete(sessionId);
	}

	private _ledgerOf(sessionId: string): AcpEditLedger {
		let ledger = this._ledgers.get(sessionId);
		if (!ledger) {
			ledger = new AcpEditLedger();
			this._ledgers.set(sessionId, ledger);
		}
		return ledger;
	}

	private _enqueue(task: () => Promise<void>): Promise<void> {
		// Сбой одной правки не должен останавливать очередь: следующая ждёт не её результата, а её конца
		this._queue = this._queue.then(task).catch(() => undefined);
		return this._queue;
	}

	private async _review(sessionId: string, path: string, diff: IAcpDiff | undefined): Promise<void> {
		const uri = URI.file(path);
		// Правки за пределами проекта в разбор не идут: отклонять там нечего, это чужие файлы
		if (!this._workspace.getWorkspaceFolder(uri)) { return; }
		try {
			if (this._textFiles.isDirty(uri)) {
				// У файла есть несохранённые правки человека: записанное агентом с ними не склеить
				this._activityLog.logError(localize('vibeide.acp.review.dirty', "Правка внешнего агента в {0} не поставлена на разбор: в файле есть несохранённые правки", path));
				return;
			}
			const current = await this._readDisk(uri);
			if (current === undefined) { return; }
			const verdict = resolveBaseline({ remembered: this._ledgerOf(sessionId).baselineOf(path), current, diff });
			if (verdict.kind === 'skip') { return; }

			// Созданный файл мог попасть в кэш существования как отсутствующий: модель его иначе не откроет
			this._models.invalidateExistenceCache(uri);
			await this._models.initializeModel(uri);
			// Модель обновляется по событию файловой системы с задержкой, а разбору нужен текст, который сейчас на диске
			await this._textFiles.files.resolve(uri, { reload: { async: false } });
			const created = verdict.kind === 'created';
			this._editCode.registerExternalEdit({
				uri,
				originalCode: verdict.kind === 'text' ? verdict.text : '',
				...(created ? { onRejected: () => { void this._removeCreated(uri); } } : {}),
			});
		} catch (err) {
			this._activityLog.logError(localize('vibeide.acp.review.failed', "Правка внешнего агента в {0} не поставлена на разбор: {1}", path, err instanceof Error ? err.message : String(err)));
		}
	}

	/** Текст файла на диске; `undefined` — файла уже нет или он не читается как текст */
	private async _readDisk(uri: URI): Promise<string | undefined> {
		try {
			return (await this._textFiles.read(uri)).value;
		} catch {
			return undefined;
		}
	}

	/**
	 * Отклонена правка, которая создала файл: файла до хода не было, значит и после отклонения его быть не должно
	 * Удаление уходит в корзину, если она есть: это единственное необратимое действие во всём разборе
	 */
	private async _removeCreated(uri: URI): Promise<void> {
		try {
			// Откат уже записан в модель, а его сохранение идёт: удалить файл раньше значило бы получить его обратно пустым
			await this._models.saveModel(uri);
			await this._files.del(uri, { useTrash: this._files.hasCapability(uri, FileSystemProviderCapabilities.Trash) });
			this._models.invalidateExistenceCache(uri);
		} catch (err) {
			this._activityLog.logError(localize('vibeide.acp.review.removeFailed', "Файл {0}, созданный внешним агентом, при отклонении не удалён: {1}", uri.fsPath, err instanceof Error ? err.message : String(err)));
		}
	}
}

registerSingleton(IVibeAcpEditReviewService, VibeAcpEditReviewService, InstantiationType.Delayed);
