/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — standalone Add / Edit editor (modal-style pane).
 *
 * Mirrors the `VibeideSettingsPane` pattern: one synthetic editor input + one
 * editor pane that mounts the React form via `mountVibeProjectCommandForm`.
 * The pane is opened by:
 *
 *   - `vibeide.commands.add`             — `mode: 'add'`, empty draft.
 *   - `vibeide.commands.editById.<id>`   — `mode: 'edit'`, prefilled draft.
 *
 * The form closes itself by issuing `workbench.action.closeActiveEditor`
 * after a successful save (or on Cancel).
 *
 * The editor resource is fixed (`vibe:project-command-form`) — opening a
 * second form replaces the first; we never accumulate orphan tabs.
 */

import { Dimension } from '../../../../base/browser/dom.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { Codicon } from '../../../../base/common/codicons.js';
import { IDisposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import * as nls from '../../../../nls.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { EditorExtensions, IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';

import { mountVibeProjectCommandForm } from './react/out/vibe-settings-tsx/index.js';
import type { AddCommandDraft } from '../common/projectCommandsAddFormPolicy.js';

export type VibeProjectCommandFormMode = 'add' | 'edit';

export interface VibeProjectCommandFormProps {
	mode: VibeProjectCommandFormMode;
	commandIdForEdit?: string;
	initialDraft?: AddCommandDraft;
}

/** Module-level current-props slot. Set by the action handlers right before
 *  opening the editor; read by the pane on mount. A fixed input resource (see
 *  `RESOURCE` below) prevents us from carrying props in the URI itself. */
let _pendingProps: VibeProjectCommandFormProps = { mode: 'add' };

export function setVibeProjectCommandFormProps(props: VibeProjectCommandFormProps): void {
	_pendingProps = props;
}

export class VibeProjectCommandFormInput extends EditorInput {
	static readonly ID = 'workbench.input.vibe.projectCommandForm';
	static readonly RESOURCE = URI.from({ scheme: 'vibe', path: 'project-command-form' });

	readonly resource = VibeProjectCommandFormInput.RESOURCE;

	override get typeId(): string {
		return VibeProjectCommandFormInput.ID;
	}

	override getName(): string {
		return nls.localize('vibeProjectCommandFormInput', 'Команда проекта');
	}

	override getIcon() {
		return Codicon.terminalCmd;
	}
}

export class VibeProjectCommandFormPane extends EditorPane {
	static readonly ID = 'workbench.pane.vibe.projectCommandForm';

	/** Root DOM element where the React form is mounted. Created once in
	 *  `createEditor`, kept across input changes. */
	private _root: HTMLElement | undefined;
	/** Currently mounted React tree. Disposed and recreated on every
	 *  `setInput` so the form picks up fresh `_pendingProps` (the action
	 *  handlers set those right before `editorService.openEditor`). Without
	 *  remount, the pane gets reused across Add/Edit invocations and the
	 *  React state from the first open lingers — the form always shows the
	 *  first-opened mode. */
	private _mount: IDisposable | undefined;

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super(VibeProjectCommandFormPane.ID, group, telemetryService, themeService, storageService);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.style.height = '100%';
		parent.style.width = '100%';

		const root = document.createElement('div');
		root.style.height = '100%';
		root.style.width = '100%';
		// Scrolling + scrollbar theming live on the inner `.vibe-scope` wrapper
		// inside the React form so the workbench `.vibe-scope::-webkit-scrollbar`
		// rules (themed via --vibe-bg-* / --vscode-scrollbar* tokens) apply.
		parent.appendChild(root);
		this._root = root;
		// Actual React mount happens in `setInput` so each open of the pane
		// re-reads `_pendingProps`.
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		await super.setInput(input, options, context, token);
		this._remount();
	}

	override clearInput(): void {
		this._disposeMount();
		super.clearInput();
	}

	override dispose(): void {
		this._disposeMount();
		super.dispose();
	}

	private _remount(): void {
		const root = this._root;
		if (!root) return;
		this._disposeMount();
		// Snapshot the props at remount time — the action handler sets
		// `_pendingProps` synchronously before calling `openEditor`, so by
		// the time `setInput` runs the slot holds the intended payload.
		const props: VibeProjectCommandFormProps = { ..._pendingProps };
		this.instantiationService.invokeFunction(accessor => {
			const mounted = mountVibeProjectCommandForm(root, accessor, props);
			const disposeFn = mounted?.dispose;
			if (disposeFn) {
				this._mount = { dispose: () => disposeFn() };
			}
		});
	}

	private _disposeMount(): void {
		if (this._mount) {
			this._mount.dispose();
			this._mount = undefined;
		}
		if (this._root) {
			while (this._root.firstChild) {
				this._root.removeChild(this._root.firstChild);
			}
		}
	}

	layout(_dimension: Dimension): void { /* form is responsive — nothing to do */ }

	override get minimumWidth() { return 480; }
}

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(VibeProjectCommandFormPane, VibeProjectCommandFormPane.ID, nls.localize('vibeProjectCommandFormPane', 'VibeIDE Форма команды проекта')),
	[new SyncDescriptor(VibeProjectCommandFormInput)],
);
