/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { StatusRowSeverity } from '../common/statusBarRowAggregator.js';
import { IVibeideSettingsService } from '../common/vibeideSettingsService.js';
import { getModelCapabilities, AUTO_DOWNGRADE_TTL_MS } from '../common/modelCapabilities.js';
import { classifyToolCallFormat } from '../common/toolCallFormatStatus.js';

/**
 * VibeIDE Tool-call Format indicator — statusbar.
 *
 * Shows whether the active Chat model talks to tools via native function-calling
 * or the XML fallback, and — when an auto-downgrade override is in effect — why.
 * The user could not previously see that a capable model (e.g. deepseek) got stuck
 * in XML mode after auto-downgrade (model-stalls #008). Clicking the indicator runs
 * the "reset auto-detected tool-format overrides" command to retry native FC.
 */
export class VibeStatusBarToolFormatContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeStatusBarToolFormat';

	private _entry: IStatusbarEntryAccessor | undefined;
	private _unifiedRow: IDisposable | undefined;

	constructor(
		@IStatusbarService private readonly _statusbarService: IStatusbarService,
		@IVibeideSettingsService private readonly _settingsService: IVibeideSettingsService,
		@IVibeUnifiedStatusBarService private readonly _unified: IVibeUnifiedStatusBarService,
		@IConfigurationService private readonly _config: IConfigurationService,
	) {
		super();
		this._wire();
		this._register(this._settingsService.onDidChangeState(() => this._refresh()));
		this._register(this._config.onDidChangeConfiguration(e => {
			if (e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) { this._wire(); }
		}));
	}

	private _compute(): { text: string; tooltip: string; severity: StatusRowSeverity } {
		const sel = this._settingsService.state.modelSelectionOfFeature['Chat'];
		const isAutoSelection = !sel || sel.providerName === 'auto' || sel.modelName === 'auto';

		const overrides = this._settingsService.state.overridesOfModel;
		const caps = isAutoSelection ? undefined : getModelCapabilities(sel.providerName, sel.modelName, overrides);
		const ov = isAutoSelection ? undefined : overrides?.[sel.providerName]?.[sel.modelName];

		const kind = classifyToolCallFormat({
			isAutoSelection,
			specialToolFormat: caps?.specialToolFormat,
			autoDetected: !!ov?._autoDetected,
			detectedAt: ov?._detectedAt,
			now: Date.now(),
			ttlMs: AUTO_DOWNGRADE_TTL_MS,
		});

		const modelLabel = isAutoSelection ? 'auto' : `${sel.providerName}/${sel.modelName}`;
		switch (kind) {
			case 'auto':
				return {
					text: '🔧 FC: auto',
					tooltip: localize('vibeToolFormatAuto', 'Модель чата выбирается автоматически — формат вызова тулов определяется для каждого запроса.'),
					severity: 'info',
				};
			case 'native':
				return {
					text: '🔧 FC: native',
					tooltip: localize('vibeToolFormatNative', 'Формат тулов для {0}: нативный function-calling ({1}).', modelLabel, caps?.specialToolFormat ?? ''),
					severity: 'info',
				};
			case 'xml-autodowngraded':
				return {
					text: '🔧 FC: XML ⚠',
					tooltip: localize('vibeToolFormatXmlAuto', 'Формат тулов для {0}: XML fallback — АВТОМАТИЧЕСКИ ПОНИЖЕН с нативного ({1}). Нажмите для сброса и повтора нативного function-calling.', modelLabel, ov?._reason ?? 'other'),
					severity: 'warn',
				};
			case 'xml':
			default:
				return {
					text: '🔧 FC: XML',
					tooltip: localize('vibeToolFormatXml', 'Формат тулов для {0}: XML fallback (эта модель не поддерживает нативный function-calling по умолчанию).', modelLabel),
					severity: 'info',
				};
		}
	}

	private _entryPropsFrom(c: { text: string; tooltip: string }): IStatusbarEntry {
		return {
			name: localize('vibeToolFormat', 'VibeIDE: формат тулов'),
			text: c.text,
			tooltip: c.tooltip,
			command: 'vibeide.toolFormat.resetAutoDetectedOverrides',
			ariaLabel: c.text,
		};
	}

	private _wire(): void {
		this._entry?.dispose(); this._entry = undefined;
		this._unifiedRow?.dispose(); this._unifiedRow = undefined;
		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		const c = this._compute();
		const p = this._entryPropsFrom(c);
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.toolFormat',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				severity: c.severity,
				priority: 175,
				command: 'vibeide.toolFormat.resetAutoDetectedOverrides',
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.toolFormat', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 175 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		const c = this._compute();
		const p = this._entryPropsFrom(c);
		this._entry?.update(p);
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.toolFormat', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined, severity: c.severity });
		}
	}

	override dispose(): void {
		this._unifiedRow?.dispose();
		this._entry?.dispose();
		super.dispose();
	}
}

registerWorkbenchContribution2(
	VibeStatusBarToolFormatContribution.ID,
	VibeStatusBarToolFormatContribution,
	WorkbenchPhase.AfterRestored
);
