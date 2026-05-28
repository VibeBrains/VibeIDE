/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
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
		if (!sel || sel.providerName === 'auto' || sel.modelName === 'auto') {
			return {
				text: '🔧 FC: auto',
				tooltip: localize('vibeToolFormatAuto', 'Chat model is auto-selected — the tool-call format is resolved per request.'),
				severity: 'info',
			};
		}

		const overrides = this._settingsService.state.overridesOfModel;
		const caps = getModelCapabilities(sel.providerName, sel.modelName, overrides);
		const isNative = !!caps.specialToolFormat;

		const ov = overrides?.[sel.providerName]?.[sel.modelName];
		const autoDowngraded = !!ov?._autoDetected
			&& typeof ov._detectedAt === 'number'
			&& (Date.now() - ov._detectedAt < AUTO_DOWNGRADE_TTL_MS);

		const modelLabel = `${sel.providerName}/${sel.modelName}`;
		if (isNative) {
			return {
				text: '🔧 FC: native',
				tooltip: localize('vibeToolFormatNative', 'Tool-call format for {0}: native function-calling ({1}).', modelLabel, caps.specialToolFormat),
				severity: 'info',
			};
		}
		if (autoDowngraded) {
			return {
				text: '🔧 FC: XML ⚠',
				tooltip: localize('vibeToolFormatXmlAuto', 'Tool-call format for {0}: XML fallback — AUTO-DOWNGRADED from native ({1}). Click to reset and retry native function-calling.', modelLabel, ov?._reason ?? 'other'),
				severity: 'warn',
			};
		}
		return {
			text: '🔧 FC: XML',
			tooltip: localize('vibeToolFormatXml', 'Tool-call format for {0}: XML fallback (this model has no native function-calling by default).', modelLabel),
			severity: 'info',
		};
	}

	private _getEntryProps(): IStatusbarEntry {
		const c = this._compute();
		return {
			name: localize('vibeToolFormat', 'VibeIDE Tool-call Format'),
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
		const p = this._getEntryProps();
		const sev = this._compute().severity;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: 'vibeide.toolFormat',
				label: p.text,
				tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined,
				severity: sev,
				priority: 175,
				command: 'vibeide.toolFormat.resetAutoDetectedOverrides',
			});
		} else {
			this._entry = this._statusbarService.addEntry(p, 'vibeide.toolFormat', StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 175 }, alignment: StatusbarAlignment.RIGHT });
		}
	}

	private _refresh(): void {
		const p = this._getEntryProps();
		const sev = this._compute().severity;
		this._entry?.update(p);
		if (this._unifiedRow) {
			this._unified.updateRow('vibeide.toolFormat', { label: p.text, tooltip: typeof p.tooltip === 'string' ? p.tooltip : undefined, severity: sev });
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
