/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import * as nls from '../../../../nls.js';
import { EditorExtensions } from '../../../common/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { Dimension } from '../../../../base/browser/dom.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';

import { mountVibeSettings } from './react/out/vibe-settings-tsx/index.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';


// refer to preferences.contribution.ts keybindings editor

class VibeideSettingsInput extends EditorInput {

	static readonly ID: string = 'workbench.input.vibe.settings';

	static readonly RESOURCE = URI.from({
		scheme: 'vibe',
		path: 'settings'
	});
	readonly resource = VibeideSettingsInput.RESOURCE;

	constructor() {
		super();
	}

	override get typeId(): string {
		return VibeideSettingsInput.ID;
	}

	override getName(): string {
		return nls.localize('vibeSettingsInputsName', 'Настройки VibeIDE');
	}

	override getIcon() {
		return Codicon.checklist; // symbol for the actual editor pane
	}

}


class VibeideSettingsPane extends EditorPane {
	static readonly ID = 'workbench.test.myCustomPane';

	// private _scrollbar: DomScrollableElement | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super(VibeideSettingsPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const settingsElt = document.createElement('div');
		settingsElt.style.height = '100%';
		settingsElt.style.width = '100%';

		parent.appendChild(settingsElt);

		// this._scrollbar = this._register(new DomScrollableElement(scrollableContent, {}));
		// parent.appendChild(this._scrollbar.getDomNode());
		// this._scrollbar.scanDomNode();

		// Mount React into the scrollable content
		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountVibeSettings(settingsElt, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));

			// setTimeout(() => { // this is a complete hack and I don't really understand how scrollbar works here
			// 	this._scrollbar?.scanDomNode();
			// }, 1000)
		});
	}

	layout(dimension: Dimension): void {
		// if (!settingsElt) return
		// settingsElt.style.height = `${dimension.height}px`;
		// settingsElt.style.width = `${dimension.width}px`;
	}


	override get minimumWidth() { return 700; }

}

// register Settings pane
Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeideSettingsPane, VibeideSettingsPane.ID, nls.localize('VibeideSettingsPane', "Панель настроек VibeIDE")),
	[new SyncDescriptor(VibeideSettingsInput)]
);


// Toggle VibeIDE settings editor; surfaced from chat view title + Global Activity (not layout title strip)
export const VIBEIDE_TOGGLE_SETTINGS_ACTION_ID = 'workbench.action.toggleVibeideSettings';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_TOGGLE_SETTINGS_ACTION_ID,
			title: nls.localize2('vibeSettings', "VibeIDE: Переключить настройки"),
			icon: Codicon.settingsGear,
			// Settings gear lives on the chat view title (and Global Activity), not in the title-bar layout strip
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// if is open, close it
		const openEditors = editorService.findEditors(VibeideSettingsInput.RESOURCE); // should only have 0 or 1 elements...
		if (openEditors.length !== 0) {
			const openEditor = openEditors[0].editor;
			const isCurrentlyOpen = editorService.activeEditor?.resource?.fsPath === openEditor.resource?.fsPath;
			if (isCurrentlyOpen) { await editorService.closeEditors(openEditors); }
			else { await editorService.openEditor(openEditor); }
			return;
		}


		// else open it
		const input = instantiationService.createInstance(VibeideSettingsInput);

		await editorService.openEditor(input);
	}
});



export const VIBEIDE_OPEN_SETTINGS_ACTION_ID = 'workbench.action.openVibeideSettings';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_SETTINGS_ACTION_ID,
			title: nls.localize2('vibeSettingsAction2', "VibeIDE: Открыть настройки"),
			f1: true,
			icon: Codicon.settingsGear,
		});
	}
	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// close all instances if found
		const openEditors = editorService.findEditors(VibeideSettingsInput.RESOURCE);
		if (openEditors.length > 0) {
			await editorService.closeEditors(openEditors);
		}

		// then, open one single editor
		const input = instantiationService.createInstance(VibeideSettingsInput);
		await editorService.openEditor(input);
	}
});





// add to settings gear on bottom left
MenuRegistry.appendMenuItem(MenuId.GlobalActivity, {
	group: '0_command',
	command: {
		id: VIBEIDE_TOGGLE_SETTINGS_ACTION_ID,
		title: nls.localize('vibeSettingsActionGear', "Настройки VibeIDE")
	},
	order: 1
});
