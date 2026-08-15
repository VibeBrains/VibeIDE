/*---------------------------------------------------------------------------------------------
 *  Copyright (c) VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { $, addDisposableListener, EventType } from '../../../../../base/browser/dom.js';
import { renderIcon } from '../../../../../base/browser/ui/iconLabel/iconLabels.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { IVibeServerStackEntry, IVibeServerStackService } from '../../../vibeide/browser/vibeServer/vibeServerStackService.js';
import { BrowserEditor, BrowserEditorContribution, BrowserWidgetLocation, IBrowserEditorWidget } from '../browserEditor.js';

/**
 * The project's dev stack (`.vibe/servers.json`) on the preview welcome screen: a
 * start-and-open list, filled in reactively from the orchestrator.
 *
 * Until VS Code 1.133 this lived inline in `BrowserEditor`'s welcome markup. Upstream then moved
 * every welcome-area element to contributed widgets, so the feature moved with it — same behaviour,
 * registered the way upstream now expects, which keeps the editor itself free of fork edits.
 */
export class VibeServerStackFeature extends BrowserEditorContribution {

	private readonly _container = $('.browser-welcome-stack');
	private readonly _rowDisposables = this._register(new DisposableStore());

	constructor(
		editor: BrowserEditor,
		@IVibeServerStackService private readonly _stackService: IVibeServerStackService,
	) {
		super(editor);

		this._register(this._stackService.onDidChangeStack(() => this._render()));
		void this._stackService.reload();
		this._render();
	}

	override get widgets(): readonly IBrowserEditorWidget[] {
		return [{
			element: this._container,
			location: BrowserWidgetLocation.ContentArea,
			// After the welcome title and subtitle, which upstream renders at lower orders.
			order: 51,
		}];
	}

	/** (Re)builds the stack list from the orchestrator's current entries. */
	private _render(): void {
		this._rowDisposables.clear();
		this._container.textContent = '';
		if (!this._stackService.available) {
			return;
		}
		for (const item of this._stackService.entries) {
			this._renderRow(item);
		}
	}

	private _renderRow(item: IVibeServerStackEntry): void {
		const running = item.state === 'running';
		const busy = item.state === 'starting';
		const row = $('.browser-welcome-stack-row');

		const name = $('.browser-welcome-stack-name');
		name.textContent = item.entry.name ?? item.entry.id;
		row.appendChild(name);

		const port = $('.browser-welcome-stack-port');
		port.textContent = typeof item.entry.port === 'number' ? `:${item.entry.port}` : '';
		row.appendChild(port);

		const button = $('.browser-welcome-stack-action');
		const icon = busy ? Codicon.loading : running ? Codicon.linkExternal : Codicon.play;
		const iconEl = renderIcon(icon);
		if (busy) {
			iconEl.classList.add('codicon-modifier-spin');
		}
		button.appendChild(iconEl);
		row.appendChild(button);

		this._rowDisposables.add(addDisposableListener(button, EventType.CLICK, () => void this._onAction(item)));
		this._container.appendChild(row);
	}

	/** A row was clicked: start the entry (with its deps) if needed, then open its preview. */
	private async _onAction(item: IVibeServerStackEntry): Promise<void> {
		if (item.state !== 'running') {
			await this._stackService.startEntry(item.entry.id);
		}
		const url = this._stackService.previewUrlFor(item.entry.id);
		if (url) {
			await this.editor.input?.navigate(url);
		}
	}
}

BrowserEditor.registerContribution(VibeServerStackFeature);
