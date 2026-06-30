/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * GDPR palette commands — N.2 roadmap (lines 1177-1178).
 *
 *  - `vibeide.gdpr.exportMyData`    — DSAR export via `vibe doctor --gdpr-export`
 *  - `vibeide.gdpr.deleteAllMyData` — Right-to-be-Forgotten via `vibe doctor --gdpr-delete`
 *
 * Pure helper `gdprWizardManifest.ts` builds the confirm bodies; the dialog
 * gate is handled here. Delegates actual export/delete work to the CLI (the
 * CLI holds the FS/audit logic without duplicating it in the workbench).
 */

import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { ITerminalService } from '../../../contrib/terminal/browser/terminal.js';
import { TerminalLocation } from '../../../../platform/terminal/common/terminal.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { localize } from '../../../../nls.js';
import {
	buildGDPRExportManifest,
	buildGDPRDeleteManifest,
	describeGDPRExportConfirm,
	describeGDPRDeleteConfirm,
	countIrreversibleDeleteItems,
} from '../common/gdprWizardManifest.js';

CommandsRegistry.registerCommand({
	id: 'vibeide.gdpr.exportMyData',
	handler: async (accessor: ServicesAccessor) => {
		const dialog = accessor.get(IDialogService);
		const terminal = accessor.get(ITerminalService);
		const notifications = accessor.get(INotificationService);

		const items = buildGDPRExportManifest();
		const body = describeGDPRExportConfirm(items);

		const confirmed = await dialog.confirm({
			message: localize('vibeide.gdpr.export.title', 'VibeIDE — экспорт моих данных (DSAR)'),
			detail: body,
			primaryButton: localize('vibeide.gdpr.export.primary', 'Экспортировать'),
		});
		if (!confirmed.confirmed) { return; }

		const t = await terminal.createTerminal({
			location: TerminalLocation.Panel,
			config: { name: localize('vibeide.gdpr.export.terminalName', 'VibeIDE GDPR Export') },
		});
		await terminal.setActiveInstance(t);
		await terminal.focusActiveInstance();
		await t.sendText('node scripts/vibe-doctor.js --gdpr-export', true);

		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.gdpr.export.launched', 'Экспорт данных запущен в терминале. Файл будет сохранён в рабочей папке.'),
		});
	},
});

CommandsRegistry.registerCommand({
	id: 'vibeide.gdpr.deleteAllMyData',
	handler: async (accessor: ServicesAccessor) => {
		const dialog = accessor.get(IDialogService);
		const quickInput = accessor.get(IQuickInputService);
		const terminal = accessor.get(ITerminalService);
		const notifications = accessor.get(INotificationService);

		const items = buildGDPRDeleteManifest();
		const body = describeGDPRDeleteConfirm(items);
		const irreversibleCount = countIrreversibleDeleteItems(items);

		const confirmed = await dialog.confirm({
			message: localize('vibeide.gdpr.delete.title', 'VibeIDE — удаление моих данных (право на забвение)'),
			detail: body,
			primaryButton: localize('vibeide.gdpr.delete.primary', 'Продолжить'),
		});
		if (!confirmed.confirmed) { return; }

		// If any items are irreversible, require the user to type "DELETE" to confirm.
		if (irreversibleCount > 0) {
			const typed = await quickInput.input({
				prompt: localize(
					'vibeide.gdpr.delete.typeConfirm',
					'Операция необратима для {0} категорий данных. Введите DELETE (заглавными) для подтверждения.',
					irreversibleCount,
				),
				validateInput: async v => v === 'DELETE'
					? undefined
					: localize('vibeide.gdpr.delete.wrongInput', 'Введите DELETE заглавными буквами'),
			});
			if (typed !== 'DELETE') { return; }
		}

		const t = await terminal.createTerminal({
			location: TerminalLocation.Panel,
			config: { name: localize('vibeide.gdpr.delete.terminalName', 'VibeIDE GDPR Delete') },
		});
		await terminal.setActiveInstance(t);
		await terminal.focusActiveInstance();
		await t.sendText('node scripts/vibe-doctor.js --gdpr-delete', true);

		notifications.notify({
			severity: Severity.Warning,
			message: localize('vibeide.gdpr.delete.launched', 'Удаление данных запущено в терминале. Операция необратима для выбранных категорий.'),
		});
	},
});
