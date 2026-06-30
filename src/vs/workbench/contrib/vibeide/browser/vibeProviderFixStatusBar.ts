/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * One-click «починить связь с провайдерами» — a status-bar wrench that resets the
 * main-process LLM transport (stale local client caches + wedged shared cloud
 * dispatcher) WITHOUT restarting the IDE. The quick-access twin of the «Сбросить
 * клиентов» button inside the «Проверка провайдеров» modal: same fix, no modal.
 *
 * Root cause it addresses: docs/knowledge/architecture/provider-diagnostics.md
 * («токены не уходят до перезапуска»). Mirrors vibeModelQuirksSourceStatusBar's
 * entry/unified-row dual wiring so it honours `vibeide.statusBar.unifiedOnly`.
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { registerVibeideFaSolidIcon } from './vibeideFontAwesomeSolid.js';

// FA6 Solid fa-wrench (U+F0AD) — reads as "repair / починить". See vibeideFontAwesomeSolid.ts.
const providerFixIcon = registerVibeideFaSolidIcon(
	'vibeide-provider-fix',
	'\uf0ad',
	localize('vibeide.providerFix.icon', 'Иконка кнопки починки связи с провайдерами.'),
);

export const VIBEIDE_FIX_PROVIDER_TRANSPORT_CMD = 'vibeide.providers.fixTransport';
const ENTRY_ID = 'vibeide.providers.fixTransport.statusbar';

// ─── Command: reset the LLM transport without restarting the IDE ───────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_FIX_PROVIDER_TRANSPORT_CMD,
			title: localize2('vibeide.providers.fixTransport', 'Починить связь с провайдерами'),
			category: { value: 'VibeIDE', original: 'VibeIDE' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const llm = accessor.get(ILLMMessageService);
		const notifications = accessor.get(INotificationService);
		try {
			await llm.resetProviderClients();
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.providers.fixTransport.ok', 'Связь с провайдерами переустановлена: кэши клиентов очищены, соединение пересоздано — перезапуск IDE не нужен.'),
			});
		} catch (err) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.providers.fixTransport.err', 'Не удалось переустановить связь: {0}', err instanceof Error ? err.message : String(err)),
			});
		}
	}
});

// ─── Status-bar entry (right) ──────────────────────────────────────────────────

export class VibeProviderFixStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderFixStatusBar';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _tooltip(): string {
		return [
			localize('vibeide.providerFix.sb.title', 'Починить связь с провайдерами'),
			localize('vibeide.providerFix.sb.desc', 'Сброс клиентов и пересоздание соединения без перезапуска IDE.'),
			localize('vibeide.providerFix.sb.when', 'Если токены перестали приходить у всех провайдеров — нажми сюда.'),
		].join('\n');
	}

	private _entryProps(): IStatusbarEntry {
		return {
			name: localize('vibeide.providerFix.sb.name', 'VibeIDE: связь с провайдерами'),
			text: `$(${providerFixIcon.id})`,
			ariaLabel: localize('vibeide.providerFix.sb.aria', 'Починить связь с провайдерами'),
			tooltip: this._tooltip(),
			command: VIBEIDE_FIX_PROVIDER_TRANSPORT_CMD,
		};
	}

	private _wire(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: ENTRY_ID,
				label: this._entryProps().text,
				tooltip: this._tooltip(),
				priority: 167,
				command: VIBEIDE_FIX_PROVIDER_TRANSPORT_CMD,
			});
		} else {
			this._entry = this._statusbarService.addEntry(
				this._entryProps(),
				ENTRY_ID,
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 167 }, alignment: StatusbarAlignment.RIGHT }
			);
		}
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeProviderFixStatusBarContribution.ID,
	VibeProviderFixStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
