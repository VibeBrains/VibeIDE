/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * «Диспетчерская агентов» — the full-width surface for the agent-run ledger.
 *
 * A status-bar counter can say how many roles are running; it cannot show what they are doing,
 * what they spent, or what the ones that already finished left behind. That needs room, so this
 * is an editor pane (same shape as the VibeIDE settings pane) rather than a sidebar view.
 */

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
import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { URI } from '../../../../base/common/uri.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { toDisposable } from '../../../../base/common/lifecycle.js';

import { mountVibeAgentsDispatch } from './react/out/vibe-agents-tsx/index.js';

class VibeAgentsDispatchInput extends EditorInput {

	static readonly ID: string = 'workbench.input.vibe.agentsDispatch';

	static readonly RESOURCE = URI.from({
		scheme: 'vibe',
		path: 'agents-dispatch'
	});
	readonly resource = VibeAgentsDispatchInput.RESOURCE;

	override get typeId(): string {
		return VibeAgentsDispatchInput.ID;
	}

	override getName(): string {
		return nls.localize('vibeAgentsDispatchInputName', 'Диспетчерская агентов');
	}

	override getIcon() {
		return Codicon.pulse;
	}
}

class VibeAgentsDispatchPane extends EditorPane {
	static readonly ID = 'workbench.editor.vibeAgentsDispatch';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(VibeAgentsDispatchPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const host = document.createElement('div');
		host.style.height = '100%';
		host.style.width = '100%';
		parent.appendChild(host);

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountVibeAgentsDispatch(host, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	layout(_dimension: Dimension): void {
		// The React tree fills its host through CSS; nothing to measure here.
	}

	override get minimumWidth() { return 600; }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeAgentsDispatchPane, VibeAgentsDispatchPane.ID, nls.localize('VibeAgentsDispatchPane', "Диспетчерская агентов VibeIDE")),
	[new SyncDescriptor(VibeAgentsDispatchInput)]
);

export const VIBEIDE_OPEN_AGENTS_DISPATCH_ACTION_ID = 'vibeide.agents.dispatch.open';
registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBEIDE_OPEN_AGENTS_DISPATCH_ACTION_ID,
			title: nls.localize2('vibeAgentsDispatchOpen', "VibeIDE: Диспетчерская агентов"),
			f1: true,
			icon: Codicon.pulse,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// Reuse the open pane instead of stacking a second copy of the same read-only surface.
		const openEditors = editorService.findEditors(VibeAgentsDispatchInput.RESOURCE);
		if (openEditors.length > 0) {
			await editorService.openEditor(openEditors[0].editor);
			return;
		}

		await editorService.openEditor(instantiationService.createInstance(VibeAgentsDispatchInput));
	}
});
