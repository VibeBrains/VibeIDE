/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Project Commands — custom popup widget that replaces the native "Команды"
 * menubar dropdown. Renders Add / SeedDemo entries + a scrollable command
 * list with inline `[pin]  <name>  [edit]  [delete]` rows.
 *
 * Pixel-targets the native VS Code menu look via `--vscode-menu-*` /
 * `--vscode-widget-shadow` / `--vscode-cornerRadius-*` tokens (see CSS
 * `.vibe-cmd-popup*` in `vibeide.css`). Anchored at the menubar button via
 * `IContextViewService.showContextView`.
 */

import { addDisposableListener, EventType, $ } from '../../../../base/browser/dom.js';
import { AnchorAlignment, AnchorPosition } from '../../../../base/browser/ui/contextview/contextview.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { Disposable, DisposableStore, IDisposable, toDisposable } from '../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../base/common/resources.js';
import Severity from '../../../../base/common/severity.js';
import { localize } from '../../../../nls.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { IContextViewService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { setPinnedInFile } from '../common/projectCommandsAddFormPolicy.js';
import {
	decodeProjectCommandsFile,
	ProjectCommand,
	sortProjectCommandsForDisplay,
} from '../common/projectCommandsTypes.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';

export interface IProjectCommandsPopupServices {
	readonly commandsService: IVibeCustomCommandsService;
	readonly commandService: ICommandService;
	readonly contextViewService: IContextViewService;
	readonly fileService: IFileService;
	readonly workspace: IWorkspaceContextService;
	readonly notifications: INotificationService;
}

/** Open the custom "Команды" popup anchored at the given menubar button.
 *  Returns a handle whose `.close()` closes the popup; `onHide` fires
 *  whenever the popup goes away (close() / outside-click / ESC). */
export function showProjectCommandsPopup(
	services: IProjectCommandsPopupServices,
	anchor: HTMLElement,
	options?: { onHide?: () => void },
): { close: () => void } {
	const open = services.contextViewService.showContextView({
		getAnchor: () => anchor,
		anchorAlignment: AnchorAlignment.LEFT,
		anchorPosition: AnchorPosition.BELOW,
		canRelayout: true,
		render: (container) => renderPopup(container, services, () => open.close()),
		onHide: () => { options?.onHide?.(); },
	});
	return open;
}

function renderPopup(
	container: HTMLElement,
	services: IProjectCommandsPopupServices,
	closePopup: () => void,
): IDisposable {
	const disposables = new DisposableStore();

	const root = $('div.vibe-cmd-popup');
	container.appendChild(root);

	const renderRows = () => {
		// Wipe and re-render on every commands change — popup is short-lived
		// but onDidChangeCommands during open (e.g. after Pin click) needs
		// to refresh visible state.
		while (root.firstChild) { root.removeChild(root.firstChild); }

		// ── Add / SeedDemo ────────────────────────────────────────────────
		root.appendChild(buildActionRow({
			label: localize('vibeide.popup.add', "Добавить команду…"),
			iconClass: 'codicon-add',
			onClick: () => {
				closePopup();
				void services.commandService.executeCommand('vibeide.commands.add');
			},
			disposables,
		}));
		root.appendChild(buildActionRow({
			label: localize('vibeide.popup.seedDemo', "Восстановить демо-команду"),
			iconClass: 'codicon-refresh',
			onClick: () => {
				closePopup();
				void services.commandService.executeCommand('vibeide.commands.seedDemo');
			},
			disposables,
		}));

		const list = sortProjectCommandsForDisplay(services.commandsService.getCommands());
		if (list.length > 0) {
			root.appendChild($('div.vibe-cmd-popup__separator'));
			for (const cmd of list) {
				root.appendChild(buildCommandRow(cmd, services, closePopup, disposables));
			}
		}
	};

	renderRows();
	// React to pin toggles or external mutations — keeps the popup in sync
	// without flicker because we replace the rows wholesale.
	disposables.add(services.commandsService.onDidChangeCommands(() => renderRows()));

	disposables.add(toDisposable(() => {
		if (root.parentElement === container) {
			container.removeChild(root);
		}
	}));
	return disposables;
}

interface IActionRowOptions {
	readonly label: string;
	readonly iconClass: string;
	readonly onClick: () => void;
	readonly disposables: DisposableStore;
}

function buildActionRow(opts: IActionRowOptions): HTMLElement {
	const row = $('div.vibe-cmd-popup-row.vibe-cmd-popup-row--simple');
	row.setAttribute('role', 'menuitem');
	row.tabIndex = 0;

	const icon = $(`span.vibe-cmd-popup-row__lead.codicon.${opts.iconClass}`);
	row.appendChild(icon);

	const label = $('span.vibe-cmd-popup-row__label');
	label.textContent = opts.label;
	row.appendChild(label);

	opts.disposables.add(addDisposableListener(row, EventType.MOUSE_DOWN, (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		opts.onClick();
	}));
	opts.disposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter' || e.key === ' ') {
			e.preventDefault();
			opts.onClick();
		}
	}));
	return row;
}

function buildCommandRow(
	cmd: ProjectCommand,
	services: IProjectCommandsPopupServices,
	closePopup: () => void,
	disposables: DisposableStore,
): HTMLElement {
	const isPinned = cmd.pinned === true;
	const row = $('div.vibe-cmd-popup-row.vibe-cmd-popup-row--command');
	row.setAttribute('role', 'menuitem');
	row.tabIndex = 0;
	if (isPinned) { row.classList.add('vibe-cmd-popup-row--pinned'); }

	// ── Left: pin toggle ─────────────────────────────────────────────────
	const pinBtn = $('button.vibe-cmd-popup-row__pin.codicon.codicon-pinned');
	pinBtn.setAttribute('type', 'button');
	pinBtn.setAttribute('title', isPinned
		? localize('vibeide.popup.row.unpinTip', "Открепить из верхнего бара")
		: localize('vibeide.popup.row.pinTip', "Закрепить в верхнем баре"));
	disposables.add(addDisposableListener(pinBtn, EventType.MOUSE_DOWN, (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		void togglePinned(services, cmd, !isPinned);
	}));
	row.appendChild(pinBtn);

	// ── Center: label (click body = Run) ────────────────────────────────
	const label = $('span.vibe-cmd-popup-row__label');
	label.textContent = cmd.name;
	label.title = cmd.description ?? cmd.name;
	row.appendChild(label);

	// ── Right: edit + delete (visible on row hover via CSS) ─────────────
	const actions = $('span.vibe-cmd-popup-row__actions');
	const editBtn = $('button.vibe-cmd-popup-row__action.codicon.codicon-edit');
	editBtn.setAttribute('type', 'button');
	editBtn.setAttribute('title', localize('vibeide.popup.row.editTip', "Редактировать команду"));
	disposables.add(addDisposableListener(editBtn, EventType.MOUSE_DOWN, (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		closePopup();
		void services.commandService.executeCommand('vibeide.commands.editById', cmd.id);
	}));
	actions.appendChild(editBtn);

	const delBtn = $('button.vibe-cmd-popup-row__action.vibe-cmd-popup-row__action--danger.codicon.codicon-trash');
	delBtn.setAttribute('type', 'button');
	delBtn.setAttribute('title', localize('vibeide.popup.row.deleteTip', "Удалить команду"));
	disposables.add(addDisposableListener(delBtn, EventType.MOUSE_DOWN, (e: MouseEvent) => {
		e.preventDefault();
		e.stopPropagation();
		closePopup();
		void services.commandService.executeCommand('vibeide.commands.deleteById', cmd.id);
	}));
	actions.appendChild(delBtn);
	row.appendChild(actions);

	// ── Body click → Run ─────────────────────────────────────────────────
	disposables.add(addDisposableListener(row, EventType.MOUSE_DOWN, (e: MouseEvent) => {
		// Only fire when the click happened outside the inline buttons.
		const target = e.target as HTMLElement;
		if (target.closest('button')) { return; }
		e.preventDefault();
		e.stopPropagation();
		closePopup();
		void services.commandsService.run(cmd.id);
	}));
	disposables.add(addDisposableListener(row, EventType.KEY_DOWN, (e: KeyboardEvent) => {
		if (e.key === 'Enter') {
			e.preventDefault();
			closePopup();
			void services.commandsService.run(cmd.id);
		}
	}));
	return row;
}

async function togglePinned(
	services: IProjectCommandsPopupServices,
	cmd: ProjectCommand,
	nextPinned: boolean,
): Promise<void> {
	const folder = services.workspace.getWorkspace().folders[0];
	if (!folder) {
		services.notifications.notify({
			severity: Severity.Warning,
			message: localize('vibeide.popup.pin.noWorkspace', "Откройте папку, чтобы закреплять команды."),
		});
		return;
	}
	const uri = joinPath(folder.uri, '.vibe', 'commands.json');
	try {
		const buf = await services.fileService.readFile(uri);
		const parsed = safeParseConfigJson(buf.value.toString());
		if (!parsed.ok) { return; }
		const decoded = decodeProjectCommandsFile(parsed.value);
		if (!decoded.ok) { return; }
		const next = setPinnedInFile(decoded.value, cmd.id, nextPinned);
		if (!next) {
			services.notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.popup.pin.globalOnly', "Команда из global-источника — изменять можно только в исходном файле."),
			});
			return;
		}
		await services.fileService.writeFile(uri, VSBuffer.fromString(next.serialized));
		await services.commandsService.reload();
	} catch (err) {
		services.notifications.notify({
			severity: Severity.Error,
			message: localize('vibeide.popup.pin.failed', "Не удалось обновить pinned: {0}", String((err as Error)?.message ?? err)),
		});
	}
}

/** No-op base class export so callers can use `instanceof` if ever needed. */
export class ProjectCommandsPopup extends Disposable { }
