/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * «Внешние агенты» — поверхность для чужого агента, работающего по ACP.
 *
 * Вкладка-редактор, а не вид в сайдбаре: решение о разрешении принимается по диффу «было → стало»,
 * а дифф, ужатый до ширины сайдбара, читать нельзя — а значит и решать по нему нельзя.
 *
 * Пока вкладка открыта, она же и спрашивает разрешение; закрытая — уступает место уведомлению,
 * которое умеет только привести человека сюда. Об открытости сообщает сервис сессий, поэтому
 * вопрос не задаётся дважды.
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
import { IVibeAcpSessionsService, VIBE_ACP_SHOW_COMMAND_ID } from './acp/vibeAcpSessionsService.js';

import { mountVibeExternalAgents } from './react/out/vibe-external-agents-tsx/index.js';

class VibeExternalAgentsInput extends EditorInput {

	static readonly ID: string = 'workbench.input.vibe.externalAgents';

	static readonly RESOURCE = URI.from({
		scheme: 'vibe',
		path: 'external-agents'
	});
	readonly resource = VibeExternalAgentsInput.RESOURCE;

	override get typeId(): string {
		return VibeExternalAgentsInput.ID;
	}

	override getName(): string {
		return nls.localize('vibeExternalAgentsInputName', 'Внешние агенты');
	}

	override getIcon() {
		return Codicon.remoteExplorer;
	}
}

class VibeExternalAgentsPane extends EditorPane {
	static readonly ID = 'workbench.editor.vibeExternalAgents';

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@IVibeAcpSessionsService private readonly sessionsService: IVibeAcpSessionsService,
	) {
		super(VibeExternalAgentsPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const host = document.createElement('div');
		host.style.height = '100%';
		host.style.width = '100%';
		parent.appendChild(host);

		// Пока поверхность жива, вопросы показывает она; закрытие возвращает их уведомлению.
		this.sessionsService.setSurfaceVisible(true);
		this._register(toDisposable(() => this.sessionsService.setSurfaceVisible(false)));

		this.instantiationService.invokeFunction(accessor => {
			const disposeFn = mountVibeExternalAgents(host, accessor)?.dispose;
			this._register(toDisposable(() => disposeFn?.()));
		});
	}

	layout(_dimension: Dimension): void {
		// Дерево React заполняет хост средствами CSS — измерять нечего.
	}

	override get minimumWidth() { return 600; }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeExternalAgentsPane, VibeExternalAgentsPane.ID, nls.localize('VibeExternalAgentsPane', "Внешние агенты VibeIDE")),
	[new SyncDescriptor(VibeExternalAgentsInput)]
);

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: VIBE_ACP_SHOW_COMMAND_ID,
			title: nls.localize2('vibeExternalAgentsOpen', "VibeIDE: Внешние агенты (ACP)"),
			f1: true,
			icon: Codicon.remoteExplorer,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const instantiationService = accessor.get(IInstantiationService);

		// Вторая копия той же поверхности показывала бы те же сессии и тот же вопрос дважды.
		const openEditors = editorService.findEditors(VibeExternalAgentsInput.RESOURCE);
		if (openEditors.length > 0) {
			await editorService.openEditor(openEditors[0].editor);
			return;
		}

		await editorService.openEditor(instantiationService.createInstance(VibeExternalAgentsInput));
	}
});
