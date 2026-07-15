/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';

// Реализация — `electron-browser/metricsService.ts`: класс проксирует канал `vibe-channel-metrics`
// через `IMainProcessService`, запрещённый и в `common/**`, и в `browser/**`.
//
// Контракт обязан остаться здесь: `IMetricsService` инжектят 12 файлов (54 вызова `capture()`), и
// его же импортирует `electron-main/sendLLMMessageChannel.ts` — то есть он держит обе стороны.
//
// ВАЖНО про имя: `capture()` — no-op (`NoOpMetricsClient`, PostHog выпилен из OSS-дерева), но
// инструментовка живая и расставлена в нужных точках. Переименование `metrics` →
// `routingOutcomeLog` СОЗНАТЕЛЬНО отложено до появления стока: имя «журнал исходов» у пустого
// приёмника обещало бы поведение, которого нет — ровно та ложь, за которую удалили унаследованную
// `telemetry/` (её README заявлял «tracks every AI interaction»). Плюс сервис не только про
// роутинг: `getDebuggingProperties()` отдаёт версии/ОС/коммит для команды `vibeDebugInfo`.
// См. `architecture/inheritedPrototypes.md` → Вектор 1.

export interface IMetricsService {
	readonly _serviceBrand: undefined;
	capture(event: string, params: Record<string, unknown>): void;
	setOptOut(val: boolean): void;
	getDebuggingProperties(): Promise<object>;
}

export const IMetricsService = createDecorator<IMetricsService>('metricsService');
