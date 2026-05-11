/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Project Commands — palette + status-bar contribution.
 *
 * Registers the canonical palette command (`vibeide.commands.runFromPalette` from
 * `projectCommandsServiceContract.PROJECT_COMMANDS_PALETTE_IDS.run`) that opens a
 * Quick Pick over the merged snapshot from `IVibeCustomCommandsService`.
 *
 * Phase scope (this commit):
 *  - Run-from-palette Quick Pick (filter by name; press Enter to spawn).
 *  - Reload (manual) palette command.
 *  - Open `.vibe/commands.json` palette command (creates a starter file when missing).
 *
 * Deferred:
 *  - Add / Edit / Delete / Pin / Unpin form UIs (Quick Pick is the MVP).
 *  - Trust confirm dialog (currently the service refuses with `unresolved-placeholders`
 *    when secrets are missing; nothing else is gated).
 *  - Status-bar `▶ N` indicator + top-bar pinned-buttons widget.
 */

import { Disposable, DisposableStore, IDisposable } from '../../../../base/common/lifecycle.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { serializeProjectCommandsInitTemplate } from '../common/projectCommandsInitTemplate.js';
import { describeUnresolvedPlaceholders } from '../common/projectCommandSecretsResolver.js';
import { commandIdToRegistryId } from '../common/projectCommandsRegistryId.js';
import { importTasksJson } from '../common/vscodeTasksJsonImporter.js';
import { decodeProjectCommandsFile, ProjectCommandsFile } from '../common/projectCommandsTypes.js';

CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.run,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.commands.runFromPalette.empty',
					'Нет проектных команд. Создайте .vibe/commands.json или используйте «VibeIDE: Open .vibe/commands.json».',
				),
			});
			return;
		}

		const items = list.map(c => ({
			label: c.pinned ? `$(pin) ${c.name}` : c.name,
			description: c.id,
			detail: c.description ?? c.command,
			commandId: c.id,
		}));

		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.runFromPalette.placeholder', 'Выберите проектную команду для запуска'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}

		const outcome = await commands.run(picked.commandId);
		if (outcome.outcome === 'refused') {
			if (outcome.reason === 'unresolved-placeholders' && outcome.unresolvedPlaceholders) {
				notifications.notify({
					severity: Severity.Warning,
					message: localize(
						'vibeide.commands.runFromPalette.unresolved',
						'Команда не запущена: отсутствуют значения для плейсхолдеров. {0}',
						describeUnresolvedPlaceholders(outcome.unresolvedPlaceholders.map(u => ({
							kind: u.kind, name: u.name, field: 'command',
						}))),
					),
				});
				return;
			}
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.runFromPalette.refused', 'Запуск отклонён: {0}', outcome.reason ?? 'unknown'),
			});
		} else if (outcome.outcome === 'failure') {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.runFromPalette.failed', 'Команда упала: {0}', outcome.reason ?? 'unknown'),
			});
		}
	},
});

CommandsRegistry.registerCommand({
	id: 'vibeide.commands.reload',
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const notifications = accessor.get(INotificationService);
		await commands.reload();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.reload.done', 'Проектные команды перечитаны. Найдено: {0}.', commands.getCommands().length),
		});
	},
});

CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.openJson,
	handler: async (accessor: ServicesAccessor) => {
		const workspace = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const editorService = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.openJson.noWorkspace', 'Откройте папку, чтобы создать .vibe/commands.json.'),
			});
			return;
		}
		const uri = joinPath(folder.uri, '.vibe', 'commands.json');
		const exists = await fileService.exists(uri);
		if (!exists) {
			const serialized = serializeProjectCommandsInitTemplate({ vibeVersion: '1.0.0' });
			await fileService.writeFile(uri, VSBuffer.fromString(serialized));
		}
		await editorService.openEditor({ resource: uri });
	},
});

// `VibeIDE: Import commands from .vscode/tasks.json` (roadmap L317).
// Reads `.vscode/tasks.json` from the first workspace folder, maps via the
// pure `importTasksJson` helper, presents a Quick Pick of importable tasks
// + skipped reasons, and on confirmation merges into `.vibe/commands.json`.
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.importTasksJson',
	handler: async (accessor: ServicesAccessor) => {
		const workspace = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const commands = accessor.get(IVibeCustomCommandsService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.importTasksJson.noWorkspace', 'Откройте папку, чтобы импортировать tasks.json.'),
			});
			return;
		}
		const tasksUri = joinPath(folder.uri, '.vscode', 'tasks.json');
		let tasksBuf;
		try {
			tasksBuf = await fileService.readFile(tasksUri);
		} catch {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.importTasksJson.missing', 'Файл .vscode/tasks.json не найден.'),
			});
			return;
		}
		let parsed: unknown;
		try {
			parsed = JSON.parse(tasksBuf.value.toString());
		} catch (e) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.importTasksJson.parseFailed', 'tasks.json: ошибка JSON: {0}', (e as Error).message),
			});
			return;
		}

		const preview = importTasksJson(parsed);
		if (preview.imported.length === 0) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeide.commands.importTasksJson.empty',
					'В tasks.json не найдено команд для импорта. Пропущено: {0}.',
					preview.skipped.length,
				),
			});
			return;
		}

		// Quick Pick lets user de-select tasks they don't want.
		const items = preview.imported.map(({ command, sourceLabel }) => ({
			label: command.name,
			description: command.id,
			detail: `${command.command}${command.args && command.args.length > 0 ? ` ${command.args.join(' ')}` : ''}`,
			picked: true,
			source: sourceLabel,
			command,
		}));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.importTasksJson.pick', 'Выберите команды для импорта (Space — toggle)'),
			canPickMany: true,
		});
		if (!picked || (Array.isArray(picked) && picked.length === 0)) {
			return;
		}
		const selected = (Array.isArray(picked) ? picked : [picked]) as ReadonlyArray<typeof items[number]>;

		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const decoded = decodeProjectCommandsFile(JSON.parse(buf.value.toString()));
			if (decoded.ok) {
				existing = decoded.value;
			}
		} catch {
			// missing or corrupt → treated as empty file (we overwrite from template).
		}

		const merged: ProjectCommandsFile = {
			vibeVersion: existing?.vibeVersion ?? '1.0.0',
			commands: [...(existing?.commands ?? []), ...selected.map(s => s.command)],
		};
		await fileService.writeFile(commandsUri, VSBuffer.fromString(JSON.stringify(merged, null, '\t') + '\n'));
		await commands.reload();

		const skippedSummary = preview.skipped.length > 0
			? localize('vibeide.commands.importTasksJson.skipped', ' Пропущено: {0}.', preview.skipped.length)
			: '';
		notifications.notify({
			severity: Severity.Info,
			message: localize(
				'vibeide.commands.importTasksJson.done',
				'Импортировано команд: {0}.{1}',
				selected.length, skippedSummary,
			),
		});
	},
});

/**
 * Workbench contribution responsible for two side-effects:
 *  1. Materialise the service so its FS-watcher starts (otherwise lazy Delayed
 *     instantiation would defer until first palette open).
 *  2. Maintain dynamic `vibeide.commands.run.<id>` registrations in
 *     `CommandsRegistry` so users can bind keybindings via the standard
 *     Keyboard Shortcuts UI.
 */
class VibeCustomCommandsContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeCustomCommands';

	/** registryId → CommandsRegistry disposable so we can dispose-and-rebind on FS change. */
	private readonly _dynamicRegistrations = new Map<string, IDisposable>();
	private readonly _registrationStore = this._register(new DisposableStore());

	constructor(@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService) {
		super();
		void _commands.reload();

		// Initial pass + listen for FS changes. The service emits `init` on the
		// first reload — we wait for that, then re-bind on every subsequent
		// `fs-change | global-paths-change | manual-reload` event.
		this._rebindDynamicCommands(_commands.getCommands());
		this._register(_commands.onDidChangeCommands(e => this._rebindDynamicCommands(e.commands)));
	}

	private _rebindDynamicCommands(commands: ReadonlyArray<{ id: string }>): void {
		// Dispose previous registrations. CommandsRegistry doesn't expose an
		// "unregister" API, but `registerCommand` returns an IDisposable that
		// removes the entry; we tracked them by registryId.
		for (const [, d] of this._dynamicRegistrations) {
			d.dispose();
		}
		this._dynamicRegistrations.clear();

		for (const c of commands) {
			const registryId = commandIdToRegistryId(c.id);
			if (registryId === null) {
				continue;
			}
			const d = CommandsRegistry.registerCommand({
				id: registryId,
				handler: async () => {
					await this._commands.run(c.id);
				},
			});
			this._dynamicRegistrations.set(registryId, d);
		}
		// Ensure the parent store releases everything at shutdown even if we
		// somehow lose a reference.
		for (const d of this._dynamicRegistrations.values()) {
			this._registrationStore.add(d);
		}
	}
}

registerWorkbenchContribution2(VibeCustomCommandsContribution.ID, VibeCustomCommandsContribution, WorkbenchPhase.AfterRestored);
