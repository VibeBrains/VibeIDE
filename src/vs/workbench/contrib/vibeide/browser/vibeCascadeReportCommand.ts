/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize2 } from '../../../../nls.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IVibeAgentRunLedgerService } from '../common/vibeAgentRunLedgerService.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { cascadeEconomics, CascadeEconomics } from '../common/cascadeEconomics.js';
import { getModelCapabilities } from '../common/modelCapabilities.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

/**
 * «Окупается ли каскад» — отчёт числом, а не ощущением.
 *
 * An escalation is paid on top of the draft that failed, so a cascade is a bet on how often the
 * cheap model is enough. The bet is winnable at a tenfold price gap and lost at a small one, and
 * nothing announces the moment it flips: the work still gets done, the bill just grows. This report
 * is the only place that number lives.
 */

const percent = (share: number | undefined): string => share === undefined ? '—' : `${Math.round(share * 100)}%`;
const money = (usd: number | undefined): string => usd === undefined ? '—' : `$${usd.toFixed(2)}`;
const tokens = (n: number): string => n.toLocaleString('ru-RU');

export function renderCascadeReport(economics: CascadeEconomics): string {
	const { attempts, escalations, escalationShare, deltaUsd, breakEvenShare } = economics;
	const lines: string[] = ['# Экономика каскада', ''];

	if (attempts === 0) {
		lines.push(
			'Каскадных шагов пока не было.',
			'',
			'Каскад включается полем `escalateTo` у шага в `.vibe/pipelines.json`: дешёвая модель',
			'делает черновик, и если шаг не удался — он повторяется на сильной. Отчёт покажет,',
			'окупается ли это, как только пройдёт первый такой шаг.',
		);
		return lines.join('\n');
	}

	lines.push(
		`Черновиков: **${attempts}**, из них эскалировано: **${escalations}** (${percent(escalationShare)}).`,
		'',
		'| Показатель | Значение |',
		'|---|---|',
		`| Токены черновиков | ${tokens(economics.draftTokens)} |`,
		`| Токены эскалаций | ${tokens(economics.escalationTokens)} |`,
		`| Потрачено каскадом | ${money(economics.spentUsd)} |`,
		`| Если бы всё делала сильная модель | ${money(economics.strongOnlyUsd)} |`,
		`| Разница | ${money(deltaUsd)} |`,
		`| Порог окупаемости | ${percent(breakEvenShare)} |`,
		'',
	);

	if (deltaUsd === undefined) {
		lines.push('Денежная часть не посчитана: цена хотя бы одной из моделей неизвестна. Считать по нулям — значит показать «сэкономлено $0.00» там, где нечего было считать.');
	} else if (deltaUsd < 0) {
		lines.push(`**Каскад окупается:** дешевле на ${money(-deltaUsd)}. Порог — эскалации выше ${percent(breakEvenShare)}; сейчас ${percent(escalationShare)}.`);
	} else {
		lines.push(`**Каскад не окупается:** дороже на ${money(deltaUsd)}. Эскалация оплачивается сверх черновика, а не вместо него, поэтому доля ${percent(escalationShare)} при пороге ${percent(breakEvenShare)} работает в минус — стоит убрать \`escalateTo\` или взять черновиком модель поближе по силе.`);
	}

	lines.push(
		'',
		'---',
		'',
		'Сравнение с «сильной моделью с самого начала» — оценка, и иначе быть не может: что сильная',
		'модель потратила бы на задачу, которую она не видела, измерить нельзя. Её цена за токен взята',
		'из тех прогонов, где она реально работала, и применена к объёму черновиков.',
	);
	return lines.join('\n');
}

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.agents.cascadeReport',
			title: localize2('vibeide.agents.cascadeReport', 'Экономика каскада'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
			icon: Codicon.graph,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		// Captured before the first await — the accessor is only valid synchronously.
		const ledger = accessor.get(IVibeAgentRunLedgerService);
		const settings = accessor.get(IVibeideSettingsService);
		const modelService = accessor.get(ITextModelService);
		const editorService = accessor.get(IEditorService);
		const commandService = accessor.get(ICommandService);
		const notifications = accessor.get(INotificationService);

		try {
			const runs = await ledger.getRuns();
			const overrides = settings.state.overridesOfModel;
			const economics = cascadeEconomics(runs, (provider, model) =>
				provider && model ? getModelCapabilities(provider, model, overrides).cost : undefined);

			const uri = URI.parse(`untitled://vibeide-cascade-${Date.now()}.md`);
			const ref = await modelService.createModelReference(uri);
			ref.object.textEditorModel?.setValue(renderCascadeReport(economics));
			ref.dispose();
			await editorService.openEditor({ resource: uri });
			try {
				await commandService.executeCommand('markdown.showPreview');
			} catch {
				// The markdown extension may be disabled — the source view is a fine outcome then.
			}
		} catch (err) {
			notifications.error(`Не удалось собрать отчёт по каскаду: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
});
