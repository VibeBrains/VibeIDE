/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


// Command-palette UX for the vibeLog diagnostic logger (vibeLog.ts):
//   - Copy Recent Logs  → dump the in-memory ring buffer to the clipboard
//   - Set Log Level     → quick-pick the level threshold
//   - Filter Categories → multi-select from categories seen this session
//   - Toggle Logging    → flip the master on/off switch
// All write to `vibeide.logging.*` settings, so the renderer bridge re-applies them live.

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IQuickInputService, IQuickPickItem } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService, ConfigurationTarget } from '../../../../platform/configuration/common/configuration.js';
import { localize, localize2 } from '../../../../nls.js';
import { vibeLog, LEVEL_NAMES } from '../common/vibeLog.js';

const CATEGORY = localize2('vibeCategory', 'VibeIDE');

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.logging.copyRecent',
			f1: true,
			title: localize2('vibeide.logging.copyRecent', 'VibeIDE: Скопировать недавние логи'),
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const clipboard = accessor.get(IClipboardService);
		const notification = accessor.get(INotificationService);
		const lines = vibeLog.getRecent();
		if (lines.length === 0) {
			notification.info(localize('vibeide.logging.bufferEmpty', 'Буфер логов VibeIDE пуст (логирование выключено или ничего ещё не записано).'));
			return;
		}
		await clipboard.writeText(lines.join('\n'));
		notification.info(localize('vibeide.logging.copied', 'Скопировано {0} строк лога VibeIDE в буфер обмена.', lines.length));
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.logging.setLevel',
			f1: true,
			title: localize2('vibeide.logging.setLevel', 'VibeIDE: Уровень логирования'),
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configuration = accessor.get(IConfigurationService);
		const current = configuration.getValue<string>('vibeide.logging.level');
		const items: IQuickPickItem[] = LEVEL_NAMES.map(name => ({
			label: name,
			description: name === current ? localize('vibeide.logging.current', '(текущий)') : undefined,
		}));
		const pick = await quickInput.pick(items, { placeHolder: localize('vibeide.logging.pickLevel', 'Порог уровня логов VibeIDE (off < error < warn < info < debug < trace)') });
		if (pick) {
			await configuration.updateValue('vibeide.logging.level', pick.label, ConfigurationTarget.USER);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.logging.filterCategories',
			f1: true,
			title: localize2('vibeide.logging.filterCategories', 'VibeIDE: Фильтр категорий логов'),
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const configuration = accessor.get(IConfigurationService);
		const notification = accessor.get(INotificationService);
		const known = vibeLog.knownCategories();
		if (known.length === 0) {
			notification.info(localize('vibeide.logging.noCategories', 'Пока не зафиксировано ни одной категории логов. Поработайте в IDE и попробуйте снова.'));
			return;
		}
		const current = new Set(configuration.getValue<string[]>('vibeide.logging.categories') ?? []);
		const items: IQuickPickItem[] = known.map(category => ({ label: category, picked: current.has(category) }));
		const picks = await quickInput.pick(items, {
			canPickMany: true,
			placeHolder: localize('vibeide.logging.pickCategories', 'Оставить в консоли только выбранные категории (ничего не выбрано = показывать все)'),
		});
		if (picks) {
			await configuration.updateValue('vibeide.logging.categories', picks.map(p => p.label), ConfigurationTarget.USER);
		}
	}
});

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: 'vibeide.logging.toggle',
			f1: true,
			title: localize2('vibeide.logging.toggle', 'VibeIDE: Включить/выключить логирование'),
			category: CATEGORY,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const configuration = accessor.get(IConfigurationService);
		const notification = accessor.get(INotificationService);
		const next = !(configuration.getValue<boolean>('vibeide.logging.enabled') ?? true);
		await configuration.updateValue('vibeide.logging.enabled', next, ConfigurationTarget.USER);
		notification.info(next
			? localize('vibeide.logging.on', 'Логирование VibeIDE включено.')
			: localize('vibeide.logging.off', 'Логирование VibeIDE выключено.'));
	}
});
