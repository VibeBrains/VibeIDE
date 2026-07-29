/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { vibeLog } from '../common/vibeLog.js';
import { IVibeSpendLedgerService } from './vibeSpendLedgerService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { displayInfoOfProviderName, ProviderId } from '../common/vibeideSettingsTypes.js';
import { SpendTotals } from '../common/spendLedger.js';

export const IVibeProviderDashboardService = createDecorator<IVibeProviderDashboardService>('vibeProviderDashboardService');

export interface IVibeProviderDashboardService {
	readonly _serviceBrand: undefined;
	/** Markdown report: which keys are configured and what they cost. */
	generateReport(): string;
}

/** Windows the report breaks the spending into. */
const WINDOWS: Array<{ days: number; label: string }> = [
	{ days: 1, label: 'Сегодня' },
	{ days: 7, label: 'За 7 дней' },
	{ days: 30, label: 'За 30 дней' },
];

const money = (usd: number): string => usd >= 0.01 || usd === 0 ? `$${usd.toFixed(2)}` : `$${usd.toFixed(4)}`;
const tokens = (n: number): string => n.toLocaleString('ru-RU');

const costCell = (t: SpendTotals): string => t.hasUnpriced ? `${money(t.costUsd)} + неизвестно` : money(t.costUsd);

/**
 * Personal key and spending panel.
 *
 * Reads the persisted spend ledger. The previous version read an in-memory fingerprint buffer
 * that no code ever wrote to and never filled in `estimatedCostUsd`, so the report was an empty
 * table with `$0.0000` — it looked like "you spent nothing" while meaning "nothing was measured".
 */
class VibeProviderDashboardService extends Disposable implements IVibeProviderDashboardService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IVibeSpendLedgerService private readonly _ledger: IVibeSpendLedgerService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
	) {
		super();
		vibeLog.debug('ProviderDashboard', 'ready');
	}

	generateReport(): string {
		const lines: string[] = ['# Ключи и расход', ''];

		lines.push(...this._keysSection(), '');
		lines.push(...this._spendSection());

		lines.push(
			'',
			'---',
			'',
			'Стоимость считается по ценам каталога моделей и реальным токенам, которые вернул провайдер;',
			'попадания в кэш промпта тарифицируются по своей ставке. Там, где цена модели неизвестна,',
			'в отчёте стоит «неизвестно» — это не ноль, а отсутствие данных. Учёт локальный: история',
			'живёт только на этом компьютере и никуда не отправляется.',
		);

		return lines.join('\n');
	}

	/** Which keys are configured, where each came from, and how much it has cost. */
	private _keysSection(): string[] {
		const state = this._settingsService.state;
		const perProviderMonth = new Map(this._ledger.perProvider(30).map(p => [p.providerId, p.totals]));

		const rows: string[] = [];
		for (const providerId of Object.keys(state.settingsOfProvider) as ProviderId[]) {
			const settings = state.settingsOfProvider[providerId];
			if (!settings?._didFillInProviderSettings) {
				continue;
			}
			const title = displayInfoOfProviderName(providerId).title;
			const spent = perProviderMonth.get(providerId);
			rows.push(`| ${title} | \`${providerId}\` | ${spent ? costCell(spent) : '—'} | ${spent ? spent.requests : 0} |`);
		}

		if (!rows.length) {
			return ['## Ключи', '', 'Ни один провайдер пока не настроен — добавьте ключ в настройках VibeIDE.'];
		}

		return [
			'## Ключи',
			'',
			'| Провайдер | id | Расход за 30 дней | Запросов |',
			'|---|---|---|---|',
			...rows,
		];
	}

	private _spendSection(): string[] {
		const lines: string[] = ['## Расход', ''];

		const summary = WINDOWS.map(w => {
			const t = this._ledger.totals(w.days);
			return `| ${w.label} | ${costCell(t)} | ${t.requests} | ${tokens(t.inputTokens)} | ${tokens(t.outputTokens)} | ${tokens(t.cachedInputTokens)} |`;
		});

		lines.push(
			'| Период | Стоимость | Запросов | Входные | Выходные | Из кэша |',
			'|---|---|---|---|---|---|',
			...summary,
			'',
		);

		const models = this._ledger.perModel(30);
		if (!models.length) {
			lines.push('_Пока ничего не потрачено — история появится после первого ответа модели._');
			return lines;
		}

		lines.push(
			'### По моделям за 30 дней',
			'',
			'| Провайдер | Модель | Стоимость | Запросов | Входные | Выходные |',
			'|---|---|---|---|---|---|',
			...models.slice(0, 20).map(m =>
				`| ${m.providerId} | ${m.modelId} | ${costCell(m.totals)} | ${m.totals.requests} | ${tokens(m.totals.inputTokens)} | ${tokens(m.totals.outputTokens)} |`),
		);

		const days = [...new Set(this._ledger.window(14).map(e => e.day))].slice(0, 14);
		if (days.length) {
			lines.push('', '### По дням', '', '| День | Стоимость | Запросов |', '|---|---|---|');
			for (const day of days) {
				const entries = this._ledger.window(14).filter(e => e.day === day);
				const t = entries.reduce<SpendTotals>((acc, e) => ({
					requests: acc.requests + e.requests,
					inputTokens: acc.inputTokens + e.inputTokens,
					outputTokens: acc.outputTokens + e.outputTokens,
					cachedInputTokens: acc.cachedInputTokens + e.cachedInputTokens,
					costUsd: acc.costUsd + (e.costUsd ?? 0),
					hasUnpriced: acc.hasUnpriced || e.costUsd === undefined,
				}), { requests: 0, inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, costUsd: 0, hasUnpriced: false });
				lines.push(`| ${day} | ${costCell(t)} | ${t.requests} |`);
			}
		}

		return lines;
	}
}

registerSingleton(IVibeProviderDashboardService, VibeProviderDashboardService, InstantiationType.Delayed);
