/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { mainWindow } from '../../../../base/browser/window.js';
import { Disposable, MutableDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { metricsCollector } from '../common/metricsCollector.js';
import { IChatThreadService } from './chatThreadService.js';
import { localProviderNames, ProviderName } from '../common/vibeideSettingsTypes.js';

export class VibeideStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideStatusBar';

	private modelEntry: IStatusbarEntryAccessor | undefined;
	private latencyEntry: IStatusbarEntryAccessor | undefined;
	private privacyEntry: IStatusbarEntryAccessor | undefined;
	private readonly updateDisposables = this._register(new MutableDisposable());

	constructor(
		@IStatusbarService private readonly statusbarService: IStatusbarService,
		@IVibeideSettingsService private readonly vibeideSettingsService: IVibeideSettingsService,
		@IChatThreadService private readonly chatThreadService: IChatThreadService,
	) {
		super();
		this.create();
		this.registerListeners();
	}

	private create(): void {
		// Model badge entry
		this.modelEntry = this.statusbarService.addEntry(
			this.getModelEntryProps(),
			'vibeide.model',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 100.2 }, alignment: StatusbarAlignment.RIGHT }
		);

		// Latency pulse entry
		this.latencyEntry = this.statusbarService.addEntry(
			this.getLatencyEntryProps(),
			'vibeide.latency',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 100.3 }, alignment: StatusbarAlignment.RIGHT }
		);

		// Privacy/offline indicator entry
		this.privacyEntry = this.statusbarService.addEntry(
			this.getPrivacyEntryProps(),
			'vibeide.privacy',
			StatusbarAlignment.RIGHT,
			{ location: { id: 'status.editor.mode', priority: 100.4 }, alignment: StatusbarAlignment.RIGHT }
		);
	}

	private registerListeners(): void {
		this.updateDisposables.value = this.vibeideSettingsService.onDidChangeState(() => {
			this.modelEntry?.update(this.getModelEntryProps());
		});

		// Listen to stream state changes to update model entry with activity indicator
		this._register(this.chatThreadService.onDidChangeStreamState(() => {
			this.modelEntry?.update(this.getModelEntryProps());
		}));

		// W.20 fix — pre-2026-05-23 unconditionally pushed 3 status-bar entry
		// updates 2×/sec forever even on idle (~36k allocs per 5h idle).
		// Now: early-return when no stream is running. `modelEntry` /
		// `privacyEntry` are still kept fresh by `onDidChangeStreamState`
		// + `onDidChangeState` events above; only the latency clock needs
		// polling during active requests.
		const latencyUpdateInterval = mainWindow.setInterval(() => {
			const streamState = this.chatThreadService.streamState;
			const currentThreadId = this.chatThreadService.state.currentThreadId;
			const isRunning = currentThreadId ? streamState[currentThreadId]?.isRunning : undefined;
			if (!isRunning) { return; }
			this.latencyEntry?.update(this.getLatencyEntryProps());
			this.modelEntry?.update(this.getModelEntryProps());
			this.privacyEntry?.update(this.getPrivacyEntryProps());
		}, 500);

		this._register({ dispose: () => mainWindow.clearInterval(latencyUpdateInterval) });
	}

	private getModelEntryProps(): IStatusbarEntry {
		const settings = this.vibeideSettingsService.state;
		const modelSelection = settings.modelSelectionOfFeature['Chat'];

		// Check if there's any active operation
		const streamState = this.chatThreadService.streamState;
		const currentThreadId = this.chatThreadService.state.currentThreadId;
		const currentStreamState = currentThreadId ? streamState[currentThreadId] : undefined;
		const isRunning = currentStreamState?.isRunning;
		const isActive = isRunning === 'LLM' || isRunning === 'tool' || isRunning === 'preparing';

		// Get status message if preparing
		const statusMessage = isRunning === 'preparing' ? currentStreamState?.llmInfo?.displayContentSoFar : undefined;

		// Check if model is local/offline
		const isLocal = modelSelection && (localProviderNames as readonly ProviderName[]).includes(modelSelection.providerName as ProviderName);
		const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

		if (!modelSelection || (modelSelection.providerName === 'auto' && modelSelection.modelName === 'auto')) {
			const icon = isActive ? '$(loading~spin)' : '$(code)';
			const text = isActive ? `${icon} Auto` : `${icon} Auto`;
			const tooltipReason = isOffline
				? '\n\n' + localize('vibeide.model.tooltip.reason.offline', 'Причина: автономный режим — используется локальная модель')
				: '\n\n' + localize('vibeide.model.tooltip.reason.auto', 'Причина: автоматический выбор модели по задаче');
			return {
				name: localize('vibeide.model', "Модель VibeIDE"),
				text,
				ariaLabel: localize('vibeide.model.auto', "VibeIDE, модель: Авто{0}", isActive ? ' (активна)' : ''),
				tooltip: statusMessage || (localize('vibeide.model.auto.tooltip', "Модель: Авто (автоматический выбор)") + tooltipReason),
			};
		}

		const modelName = modelSelection.modelName;
		const providerName = modelSelection.providerName;
		const displayName = modelName.length > 15 ? modelName.substring(0, 12) + '...' : modelName;
		const icon = isActive ? '$(loading~spin)' : '$(code)';

		// Build enhanced tooltip with reasoning
		let tooltip = statusMessage || localize('vibeide.model.tooltip', "Модель: {0} ({1})", modelName, providerName);

		// Add privacy/offline explanation
		if (isLocal) {
			tooltip += '\n\n' + localize('vibeide.model.tooltip.privacy.local', 'Конфиденциальность: локальная/офлайн-модель — данные остаются на устройстве');
		} else if (isOffline) {
			tooltip += '\n\n' + localize('vibeide.model.tooltip.privacy.offline.fallback', 'Примечание: нет сети — используется кешированная/резервная модель');
		} else {
			tooltip += '\n\n' + localize('vibeide.model.tooltip.privacy.remote', 'Конфиденциальность: удалённая модель — данные передаются провайдеру');
		}

		// Note: Routing reasoning could be added to metrics in the future
		// to provide more detailed "why this model" explanations

		return {
			name: localize('vibeide.model', "Модель VibeIDE"),
			text: `${icon} ${displayName}`,
			ariaLabel: localize('vibeide.model.selected', "VibeIDE, модель: {0} ({1}){2}", modelName, providerName, isActive ? ' (активна)' : ''),
			tooltip,
		};
	}

	private getLatencyEntryProps(): IStatusbarEntry {
		// Get latest metrics from latency audit
		const allMetrics = metricsCollector.getAll();
		if (allMetrics.length === 0) {
			return {
				name: localize('vibeide.latency', "Задержка VibeIDE"),
				text: '',
				ariaLabel: localize('vibeide.latency.idle', "VibeIDE, задержка: нет активности"),
			};
		}

		// Get the most recent request
		const latest = allMetrics[allMetrics.length - 1];
		const ttfs = latest.ttfs;
		const tts = latest.tts;

		// Determine latency status
		let icon = '$(pulse)';
		let status = 'good';

		if (ttfs > 0 && ttfs < 400) {
			status = 'good';
			icon = '$(pulse)';
		} else if (ttfs >= 400 && ttfs < 1000) {
			status = 'warning';
			icon = '$(warning)';
		} else if (ttfs >= 1000) {
			status = 'slow';
			icon = '$(clock)';
		}

		// Calculate tokens per second if available
		let tokensPerSec = '';
		if (tts > 0 && latest.outputTokens > 0) {
			const tps = Math.round((latest.outputTokens / tts) * 1000);
			tokensPerSec = ` ${tps} tok/s`;
		}

		const ttfsDisplay = ttfs > 0 ? `${Math.round(ttfs)}ms` : '—';
		const text = `${icon} ${ttfsDisplay}${tokensPerSec}`;

		const speedLine = tokensPerSec ? '\n' + localize('vibeide.latency.speedLine', 'Скорость: {0}', tokensPerSec.trim()) : '';
		return {
			name: localize('vibeide.latency', "Задержка VibeIDE"),
			text,
			ariaLabel: localize('vibeide.latency.status', "VibeIDE, задержка: TTFS {0}, статус: {1}", ttfsDisplay, status),
			tooltip: localize('vibeide.latency.tooltip', "Время до первого токена: {0}мс\nВремя стриминга: {1}мс{2}", ttfs, tts, speedLine),
		};
	}

	private getPrivacyEntryProps(): IStatusbarEntry {
		const settings = this.vibeideSettingsService.state;
		const modelSelection = settings.modelSelectionOfFeature['Chat'];

		// Check if offline
		const isOffline = typeof navigator !== 'undefined' && !navigator.onLine;

		// Check if model is local
		const isLocal = modelSelection && (localProviderNames as readonly ProviderName[]).includes(modelSelection.providerName as ProviderName);

		// Only show privacy indicator if local or offline
		if (!isLocal && !isOffline) {
			return {
				name: localize('vibeide.privacy', "Конфиденциальность VibeIDE"),
				text: '', // Hide when not applicable
				ariaLabel: '',
			};
		}

		// Determine icon and tooltip
		let icon = '$(lock)';
		let tooltip = '';

		if (isOffline && isLocal) {
			icon = '$(lock)';
			tooltip = localize('vibeide.privacy.offline.local', "Конфиденциальность: автономный режим с локальной моделью\n\nДанные остаются на вашем устройстве и не передаются на внешние серверы.");
		} else if (isOffline) {
			icon = '$(cloud-offline)';
			tooltip = localize('vibeide.privacy.offline', "Конфиденциальность: нет сети\n\nСетевое подключение недоступно.");
		} else if (isLocal) {
			icon = '$(lock)';
			tooltip = localize('vibeide.privacy.local', "Конфиденциальность: локальная модель\n\nДанные остаются на вашем устройстве и не передаются на внешние серверы.\n\nПочему эта модель: включён режим конфиденциальности или для этой задачи предпочтена локальная модель.");
		}

		return {
			name: localize('vibeide.privacy', "Конфиденциальность VibeIDE"),
			text: icon,
			ariaLabel: localize('vibeide.privacy.aria', "VibeIDE, конфиденциальность: {0}", isOffline ? 'офлайн' : 'локально'),
			tooltip,
		};
	}

	override dispose(): void {
		super.dispose();
		this.modelEntry?.dispose();
		this.latencyEntry?.dispose();
		this.privacyEntry?.dispose();
		this.modelEntry = undefined;
		this.latencyEntry = undefined;
		this.privacyEntry = undefined;
	}
}

// Register the contribution
registerWorkbenchContribution2(VibeideStatusBarContribution.ID, VibeideStatusBarContribution, WorkbenchPhase.AfterRestored);

