/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Status-bar indicator that all LLM traffic is being routed through a proxy
 * (`vibeide.llm.proxy.url`). Visible ONLY when a proxy is configured — an empty
 * setting leaves the status bar untouched. Clicking opens Settings focused on the
 * proxy key so the user can inspect or disable it fast.
 *
 * Purpose: make an easy-to-forget global network override visible. The proxy reaches
 * geo-blocked provider APIs through a foreign exit — see
 * docs/knowledge/runtimeQuirks/llmProxyDispatcher.md. Mirrors vibeProviderFixStatusBar's
 * entry/unified-row dual wiring so it honours `vibeide.statusBar.unifiedOnly`.
 */

import { Disposable, IDisposable } from '../../../../base/common/lifecycle.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStatusbarEntry, IStatusbarEntryAccessor, IStatusbarService, StatusbarAlignment } from '../../../services/statusbar/browser/statusbar.js';
import { IVibeUnifiedStatusBarService } from '../common/vibeUnifiedStatusBarService.js';
import { VIBE_COMMAND_CATEGORY } from '../common/vibeCommandCategory.js';

const PROXY_SETTING_KEY = 'vibeide.llm.proxy.url';
export const VIBEIDE_OPEN_PROXY_SETTINGS_CMD = 'vibeide.llm.proxy.openSettings';
const ENTRY_ID = 'vibeide.llm.proxy.statusbar';

/** Strip credentials from a proxy URL so it is safe to display. Falls back to a scheme-only hint. */
function redactProxyUrl(url: string): string {
	try {
		const u = new URL(url);
		u.username = '';
		u.password = '';
		return u.href;
	} catch {
		return url.split('://')[0] ?? url;
	}
}

// ─── Command: reveal the proxy setting ─────────────────────────────────────────

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_PROXY_SETTINGS_CMD,
			title: localize2('vibeide.llm.proxy.openSettings', 'Открыть настройку прокси для AI-провайдеров'),
			category: VIBE_COMMAND_CATEGORY,
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		await accessor.get(ICommandService).executeCommand('workbench.action.openSettings', `@id:${PROXY_SETTING_KEY}`);
	}
});

// ─── Status-bar entry (right) — shown only while a proxy is configured ──────────

export class VibeProviderProxyStatusBarContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeProviderProxyStatusBar';

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
			if (e.affectsConfiguration(PROXY_SETTING_KEY) || e.affectsConfiguration('vibeide.statusBar.unifiedOnly')) {
				this._wire();
			}
		}));
	}

	private _proxyUrl(): string | undefined {
		const raw = this._config.getValue<string>(PROXY_SETTING_KEY);
		return raw && raw.trim() ? raw.trim() : undefined;
	}

	private _tooltip(proxy: string): string {
		return [
			localize('vibeide.llm.proxy.sb.title', 'AI-трафик идёт через прокси'),
			localize('vibeide.llm.proxy.sb.target', 'Прокси: {0}', redactProxyUrl(proxy)),
			localize('vibeide.llm.proxy.sb.desc', 'Весь трафик к моделям маршрутизируется через этот прокси (обход гео-блокировки API). Нажми, чтобы открыть настройку.'),
		].join('\n');
	}

	private _entryProps(proxy: string): IStatusbarEntry {
		return {
			name: localize('vibeide.llm.proxy.sb.name', 'VibeIDE: прокси AI-провайдеров'),
			text: `$(globe) ${localize('vibeide.llm.proxy.sb.text', 'AI → прокси')}`,
			ariaLabel: localize('vibeide.llm.proxy.sb.aria', 'AI-трафик идёт через прокси'),
			tooltip: this._tooltip(proxy),
			command: VIBEIDE_OPEN_PROXY_SETTINGS_CMD,
		};
	}

	private _wire(): void {
		this._entry?.dispose();
		this._entry = undefined;
		this._unifiedRow?.dispose();
		this._unifiedRow = undefined;

		const proxy = this._proxyUrl();
		if (!proxy) { return; } // no proxy configured — stay invisible

		const unifiedOnly = this._config.getValue<boolean>('vibeide.statusBar.unifiedOnly') === true;
		if (unifiedOnly) {
			this._unifiedRow = this._unified.registerRow({
				id: ENTRY_ID,
				label: this._entryProps(proxy).text,
				tooltip: this._tooltip(proxy),
				priority: 166,
				command: VIBEIDE_OPEN_PROXY_SETTINGS_CMD,
			});
		} else {
			this._entry = this._statusbarService.addEntry(
				this._entryProps(proxy),
				ENTRY_ID,
				StatusbarAlignment.RIGHT,
				{ location: { id: 'status.editor.mode', priority: 166 }, alignment: StatusbarAlignment.RIGHT }
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
	VibeProviderProxyStatusBarContribution.ID,
	VibeProviderProxyStatusBarContribution,
	WorkbenchPhase.AfterRestored
);
