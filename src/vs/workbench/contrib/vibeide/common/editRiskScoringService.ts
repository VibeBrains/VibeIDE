/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { URI } from '../../../../base/common/uri.js';
import { IMarkerService, MarkerSeverity } from '../../../../platform/markers/common/markers.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IEditRiskScore, scoreEditRisk, type EditOperation } from './editRiskScoring.js';

/**
 * Оценка риска правки — сервисная обёртка.
 *
 * Решение принимает чистое ядро `editRiskScoring.ts`; здесь только сбор того, что без окружения
 * не узнать (сколько ошибок уже висит на файле), и адаптация формы вызова. До 14.08.2026 правила
 * жили прямо здесь вперемешку с сервисами и потому не проверялись ни одним тестом — цена
 * известна: пять дефектов, включая автоодобрение правки `.env`.
 */

export const IEditRiskScoringService = createDecorator<IEditRiskScoringService>('editRiskScoringService');

/** Совместимая с прежней форма результата — потребитель в `chatThreadService` не меняется. */
export type EditRiskScore = IEditRiskScore;

export interface EditContext {
	/** URI of file being edited */
	uri: URI;
	/** Original file content (if available) */
	originalContent?: string;
	/** New file content (for rewrite_file) */
	newContent?: string;
	/** Operation type */
	operation: EditOperation;
	/** Whether file was read before edit */
	fileWasRead?: boolean;
	/** Number of files being edited in this operation */
	totalFilesInOperation?: number;
}

export interface IEditRiskScoringService {
	readonly _serviceBrand: undefined;

	/**
	 * Score the risk and confidence of an edit operation
	 */
	scoreEdit(context: EditContext): Promise<EditRiskScore>;
}

class EditRiskScoringService extends Disposable implements IEditRiskScoringService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IMarkerService private readonly markerService: IMarkerService,
	) {
		super();
	}

	async scoreEdit(context: EditContext): Promise<EditRiskScore> {
		// Единственное, чего чистое ядро не может узнать само. Отсутствие маркеров — это «файл не
		// открыт», а не «ошибок нет», поэтому провал чтения не превращается в ноль молча: ядро
		// получает `undefined` и просто не учитывает признак.
		let existingErrorCount: number | undefined;
		try {
			existingErrorCount = this.markerService
				.read({ resource: context.uri })
				.filter(marker => marker.severity === MarkerSeverity.Error)
				.length;
		} catch {
			existingErrorCount = undefined;
		}

		return scoreEditRisk({
			operation: context.operation,
			filePath: context.uri.path,
			originalLength: context.originalContent?.length,
			newLength: context.newContent?.length,
			existingErrorCount,
			fileWasRead: context.fileWasRead,
			totalFilesInOperation: context.totalFilesInOperation,
		});
	}
}

registerSingleton(IEditRiskScoringService, EditRiskScoringService, InstantiationType.Delayed);
