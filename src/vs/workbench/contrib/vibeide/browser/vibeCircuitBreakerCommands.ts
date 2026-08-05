/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «VibeIDE: Предохранители агента» — see what is stopped and lift it.
 *
 * A latching breaker exists precisely so a person has to look at it. This is that look: what
 * tripped, why, and whether it will resume on its own. Lifting a security breaker is an explicit
 * confirmation, not a click — the state it guards is the reason it latched.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { localize, localize2 } from '../../../../nls.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { BREAKER_CONFIGS, BreakerId, breakerName, describeBreaker, IVibeCircuitBreakerService } from '../common/agentCircuitBreakers.js';

export const VIBEIDE_CIRCUIT_BREAKERS_ACTION_ID = 'vibeide.agents.circuitBreakers';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_CIRCUIT_BREAKERS_ACTION_ID,
			title: localize2('vibeide.agents.circuitBreakers', "VibeIDE: Предохранители агента"),
			f1: true,
			icon: Codicon.zap,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const breakers = accessor.get(IVibeCircuitBreakerService);
		const quickInput = accessor.get(IQuickInputService);
		const dialogs = accessor.get(IDialogService);
		const notifications = accessor.get(INotificationService);

		const all = breakers.all();
		const tripped = all.filter(snapshot => snapshot.state !== 'closed');
		if (tripped.length === 0) {
			// Say the count out loud: "всё в порядке" is only trustworthy when it names what was checked.
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.breakers.allClosed', 'Все предохранители в норме ({0} шт.) — ничего не остановлено.', all.length),
			});
			return;
		}

		const picked = await quickInput.pick(
			tripped.map(snapshot => ({
				label: breakerName(snapshot.id),
				description: describeBreaker(snapshot),
				detail: localize('vibeide.breakers.trips', 'срабатываний: {0}', snapshot.trips),
				id: snapshot.id as BreakerId,
			})),
			{
				title: localize('vibeide.breakers.pickTitle', 'Предохранители: что остановлено'),
				placeHolder: localize('vibeide.breakers.pickHint', 'Выберите, чтобы снять'),
			}
		);
		if (!picked) {
			return;
		}

		if (BREAKER_CONFIGS[picked.id].security) {
			const confirmation = await dialogs.confirm({
				type: 'warning',
				message: localize('vibeide.breakers.confirmTitle', 'Снять защитный предохранитель «{0}»?', breakerName(picked.id)),
				detail: localize('vibeide.breakers.confirmDetail', 'Он сработал на том, что затрагивает ваши данные, и сам не снимется. Убедитесь, что причина устранена, — иначе он сработает снова.'),
				primaryButton: localize('vibeide.breakers.confirmYes', 'Снять'),
			});
			if (!confirmation.confirmed) {
				return;
			}
		}

		const after = breakers.recover(picked.id, true);
		notifications.notify({
			severity: Severity.Info,
			message: after.state === 'closed'
				? localize('vibeide.breakers.lifted', 'Предохранитель «{0}» снят.', breakerName(picked.id))
				: localize('vibeide.breakers.notLifted', 'Предохранитель «{0}» остался в состоянии «{1}».', breakerName(picked.id), after.state),
		});
	}
});
