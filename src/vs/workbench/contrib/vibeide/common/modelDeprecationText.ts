/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { localize } from '../../../../nls.js';
import { getModelCapabilities } from './modelCapabilities.js';
import { DeprecationStatus, deprecationStatus, displayDeprecationDate } from './modelDeprecation.js';
import { ModelSelection, OverridesOfModel } from './vibeideSettingsTypes.js';

/**
 * What the model picker says about a model the vendor is retiring — the words for the verdict of `modelDeprecation`
 * One source for every place a model is picked by hand: the chat picker, the role model select, the retry list
 */

/** The model's retirement as the picker shows it: the verdict and the vendor's date; `undefined` when none is declared */
export function retirementOfModel(selection: ModelSelection, overridesOfModel: OverridesOfModel | undefined, now: number): { readonly status: DeprecationStatus; readonly date: string | undefined } | undefined {
	if (selection.providerName === 'auto') {
		return undefined;
	}
	const { deprecation } = getModelCapabilities(selection.providerName, selection.modelName, overridesOfModel);
	const status = deprecationStatus(deprecation, now);
	return status ? { status, date: deprecation?.date } : undefined;
}

/** The retirement in a few words, next to the model's name where only a line of text fits */
export function deprecationShortLabel(status: DeprecationStatus, date: string | undefined): string {
	const shown = displayDeprecationDate(date);
	if (status.severity === 'retired') {
		return localize('vibeide.modelDeprecation.short.retired', "выключена вендором");
	}
	return shown
		? localize('vibeide.modelDeprecation.short.retiring', "выключится {0}", shown)
		: localize('vibeide.modelDeprecation.short.announced', "снимается вендором");
}

/**
 * The retirement in full, for the tooltip of the model's marker
 * Says what automatic selection does with a retired model: it stays the user's to pick by hand
 */
export function deprecationTooltip(status: DeprecationStatus, date: string | undefined): string {
	const shown = displayDeprecationDate(date) ?? '';
	const lines: string[] = [];
	if (status.severity === 'retired') {
		lines.push(localize('vibeide.modelDeprecation.tooltip.retired', "Вендор выключил модель {0} — {1} дн. назад", shown, -(status.daysLeft ?? 0)));
		lines.push(localize('vibeide.modelDeprecation.tooltip.retiredHandPick', "Автовыбор её не берёт; выбрать вручную можно — по корпоративному договору она может работать"));
	} else if (status.daysLeft === undefined) {
		lines.push(localize('vibeide.modelDeprecation.tooltip.announced', "Вендор объявил, что модель снимается, дату не назвал"));
	} else if (status.daysLeft === 0) {
		lines.push(localize('vibeide.modelDeprecation.tooltip.today', "Вендор выключает модель сегодня, {0}", shown));
	} else {
		lines.push(localize('vibeide.modelDeprecation.tooltip.ahead', "Вендор выключит модель {0} — через {1} дн.", shown, status.daysLeft));
	}
	if (status.replacedBy) {
		lines.push(localize('vibeide.modelDeprecation.tooltip.replacedBy', "Замена — {0}", status.replacedBy));
	}
	if (status.note) {
		lines.push(status.note);
	}
	return lines.join('\n');
}
