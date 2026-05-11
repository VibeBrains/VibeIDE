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
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { joinPath } from '../../../../base/common/resources.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { localize } from '../../../../nls.js';
import { IVibeCustomCommandsService } from './vibeCustomCommandsService.js';
import { PROJECT_COMMANDS_PALETTE_IDS } from '../common/projectCommandsServiceContract.js';
import { serializeProjectCommandsInitTemplate } from '../common/projectCommandsInitTemplate.js';
import { describeUnresolvedPlaceholders } from '../common/projectCommandSecretsResolver.js';
import { commandIdToRegistryId, formatProjectCommandKeybindingLabel } from '../common/projectCommandsRegistryId.js';
import { allocateDefaultChords } from '../common/projectCommandsKeybindings.js';
import { importTasksJson } from '../common/vscodeTasksJsonImporter.js';
import { sanitizeProjectCommand, describeIssue } from '../common/projectCommandsSanitizer.js';
import { decodeProjectCommandsFile, ProjectCommandsFile, ProjectCommand } from '../common/projectCommandsTypes.js';
import { KeybindingsRegistry, KeybindingWeight } from '../../../../platform/keybinding/common/keybindingsRegistry.js';
import { KeyMod, KeyCode } from '../../../../base/common/keyCodes.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { renderImportDiffMarkdown, ProjectCommandLite } from '../common/commandsImportDiff.js';
import { prepareCommandsPackImport } from '../common/projectCommandsCommunityCatalog.js';
import { ComputedHash, decodePackEnvelope } from '../common/skillPackVerifier.js';

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

		// L332 sanitiser gate: refuse imports with zero-width / Bidi / control /
		// shell-metachar issues before they reach the Quick Pick. User sees a
		// warn-notification listing each unsafe command + its first issue.
		const unsafe: { name: string; reason: string }[] = [];
		const safeImports = preview.imported.filter(({ command }) => {
			const sanResult = sanitizeProjectCommand(command);
			if (!sanResult.ok) {
				unsafe.push({ name: command.name, reason: describeIssue(sanResult.issues[0]) });
				return false;
			}
			return true;
		});
		if (unsafe.length > 0) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize(
					'vibeide.commands.importTasksJson.unsafe',
					'Отклонено {0} команд из-за небезопасного содержимого: {1}',
					unsafe.length,
					unsafe.slice(0, 3).map(u => `${u.name} (${u.reason})`).join('; ') + (unsafe.length > 3 ? '…' : ''),
				),
			});
		}
		if (safeImports.length === 0) {
			return;
		}

		// Quick Pick lets user de-select tasks they don't want.
		const items = safeImports.map(({ command, sourceLabel }) => ({
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

// Edit / Delete / Copy-command-line palette commands (roadmap L323 — three
// of the five context-menu actions; the other two — `run` and `unpin` — are
// already registered above). Each is exposed both via Command Palette and
// programmatically so a future top-bar widget (L321) can dispatch from a
// right-click handler without adding new ids.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.edit,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const workspace = accessor.get(IWorkspaceContextService);
		const editorService = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.commands.edit.empty', 'Нет проектных команд для редактирования.') });
			return;
		}
		const picked = await quickInput.pick(
			list.map(c => ({ label: c.name, description: c.id, commandId: c.id })),
			{ placeHolder: localize('vibeide.commands.edit.placeholder', 'Выберите команду для редактирования') },
		);
		if (!picked) return;

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) return;
		const uri = joinPath(folder.uri, '.vibe', 'commands.json');
		// Open the file editor; ids are unique within the doc so users find
		// the picked command via Find quickly. A proper "Reveal id N" jump
		// would need a JSON document tracker — out of scope for this commit.
		await editorService.openEditor({ resource: uri });
	},
});

CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.delete,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const workspace = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);
		const notifications = accessor.get(INotificationService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.commands.delete.empty', 'Нет проектных команд для удаления.') });
			return;
		}
		const picked = await quickInput.pick(
			list.map(c => ({ label: c.name, description: c.id, commandId: c.id })),
			{ placeHolder: localize('vibeide.commands.delete.placeholder', 'Выберите команду для удаления') },
		);
		if (!picked) return;

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) return;
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let raw: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const decoded = decodeProjectCommandsFile(JSON.parse(buf.value.toString()));
			if (decoded.ok) raw = decoded.value;
		} catch { /* fall through */ }
		if (raw === null) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.delete.globalOnly', 'Команда доступна только из глобального источника — удалите её в исходном файле.'),
			});
			return;
		}
		const next: ProjectCommandsFile = {
			vibeVersion: raw.vibeVersion,
			commands: raw.commands.filter(c => c.id !== picked.commandId),
		};
		if (next.commands.length === raw.commands.length) {
			// Picked command came from a global path, not the local file.
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.delete.globalOnly', 'Команда доступна только из глобального источника — удалите её в исходном файле.'),
			});
			return;
		}
		await fileService.writeFile(commandsUri, VSBuffer.fromString(JSON.stringify(next, null, '\t') + '\n'));
		await commands.reload();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.delete.done', 'Команда «{0}» удалена.', picked.label),
		});
	},
});

CommandsRegistry.registerCommand({
	id: 'vibeide.commands.copyCommandLine',
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const clipboard = accessor.get(IClipboardService);
		const notifications = accessor.get(INotificationService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.commands.copy.empty', 'Нет проектных команд для копирования.') });
			return;
		}
		const picked = await quickInput.pick(
			list.map(c => {
				const argSuffix = (c.args && c.args.length > 0) ? ' ' + c.args.join(' ') : '';
				const full = `${c.command}${argSuffix}`;
				return { label: c.name, description: c.id, detail: full, full };
			}),
			{ placeHolder: localize('vibeide.commands.copy.placeholder', 'Выберите команду — её shell-строка скопируется в буфер'), matchOnDetail: true },
		);
		if (!picked) return;
		await clipboard.writeText(picked.full);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.copy.done', 'Скопировано в буфер: {0}', picked.full),
		});
	},
});

// Pin / Unpin palette commands. Flip `pinned: true|false` in-place inside
// `.vibe/commands.json` for the picked command id. Triggers `reload()` so the
// status-bar + chord allocator see the updated set immediately.
function registerPinTogglePalette(targetPinned: boolean): void {
	const paletteId = targetPinned ? PROJECT_COMMANDS_PALETTE_IDS.pin : PROJECT_COMMANDS_PALETTE_IDS.unpin;
	CommandsRegistry.registerCommand({
		id: paletteId,
		handler: async (accessor: ServicesAccessor) => {
			const commands = accessor.get(IVibeCustomCommandsService);
			const quickInput = accessor.get(IQuickInputService);
			const workspace = accessor.get(IWorkspaceContextService);
			const fileService = accessor.get(IFileService);
			const notifications = accessor.get(INotificationService);

			const list = commands.getCommands();
			// When pinning: show non-pinned. When unpinning: show currently-pinned.
			const candidates = list.filter(c => (c.pinned === true) !== targetPinned);
			if (candidates.length === 0) {
				notifications.notify({
					severity: Severity.Info,
					message: targetPinned
						? localize('vibeide.commands.pin.nothing', 'Все команды уже закреплены.')
						: localize('vibeide.commands.unpin.nothing', 'Нет закреплённых команд.'),
				});
				return;
			}
			const picked = await quickInput.pick(
				candidates.map(c => ({ label: c.name, description: c.id, commandId: c.id })),
				{ placeHolder: targetPinned
					? localize('vibeide.commands.pin.placeholder', 'Выберите команду, чтобы закрепить')
					: localize('vibeide.commands.unpin.placeholder', 'Выберите команду, чтобы открепить'),
				},
			);
			if (!picked) {
				return;
			}

			const folder = workspace.getWorkspace().folders[0];
			if (!folder) return;
			const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
			let raw: ProjectCommandsFile | null = null;
			try {
				const buf = await fileService.readFile(commandsUri);
				const decoded = decodeProjectCommandsFile(JSON.parse(buf.value.toString()));
				if (decoded.ok) raw = decoded.value;
			} catch { /* fallthrough */ }
			if (raw === null) {
				notifications.notify({
					severity: Severity.Warning,
					message: localize('vibeide.commands.pin.noFile', 'Команда видна только из глобального источника — изменить `pinned` нельзя без локального .vibe/commands.json.'),
				});
				return;
			}
			const next: ProjectCommandsFile = {
				vibeVersion: raw.vibeVersion,
				commands: raw.commands.map(c => c.id === picked.commandId ? { ...c, pinned: targetPinned } : c),
			};
			await fileService.writeFile(commandsUri, VSBuffer.fromString(JSON.stringify(next, null, '\t') + '\n'));
			await commands.reload();
		},
	});
}
registerPinTogglePalette(true);
registerPinTogglePalette(false);

// `VibeIDE: Revoke trust for project command` (roadmap K.2 L920).
// Opens a Quick Pick of currently-trusted command ids, revokes the selected one,
// and also prunes any orphaned / shape-changed entries as a side-effect.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.revokeTrust,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const trusted = await commands.getTrustedCommandIds();
		if (trusted.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.revokeTrust.empty', 'Нет доверенных команд для отзыва.'),
			});
			return;
		}

		const allCommands = commands.getCommands();
		const items = trusted.map(id => {
			const cmd = allCommands.find(c => c.id === id);
			return { label: cmd?.name ?? id, description: id, commandId: id };
		});

		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.revokeTrust.placeholder', 'Выберите команду для отзыва доверия'),
		});
		if (!picked) return;

		await commands.revokeTrust(picked.commandId);
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.revokeTrust.done', 'Доверие к команде «{0}» отозвано. При следующем запуске потребуется подтверждение.', picked.label),
		});
	},
});

// `VibeIDE: Import project commands from URL` (roadmap L918).
// Fetches a community pack (vibe-community-commands-pack-v1), verifies SHA-256,
// renders a per-command diff in a confirm dialog, then writes .vibe/commands.json.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.importFromUrl,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const dialog = accessor.get(IDialogService);
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);

		const rawUrl = await quickInput.input({
			placeHolder: localize('vibeide.commands.importFromUrl.placeholder', 'https://... (vibe-community-commands-pack-v1)'),
			prompt: localize('vibeide.commands.importFromUrl.prompt', 'Введите HTTPS URL файла community commands pack'),
			validateInput: async v => {
				const t = v.trim();
				if (!t) return null;
				if (!t.startsWith('https://')) return localize('vibeide.commands.importFromUrl.notHttps', 'Разрешены только HTTPS URL.');
				return null;
			},
		});
		if (!rawUrl?.trim()) return;
		const url = rawUrl.trim();
		if (!url.startsWith('https://')) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.commands.importFromUrl.notHttps', 'Разрешены только HTTPS URL.') });
			return;
		}

		let raw: unknown;
		try {
			const resp = await fetch(url);
			if (!resp.ok) {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.fetchFailed', 'Не удалось загрузить pack: HTTP {0}', resp.status) });
				return;
			}
			raw = await resp.json();
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.fetchError', 'Ошибка при загрузке pack: {0}', (e as Error).message ?? String(e)) });
			return;
		}

		const envelopeResult = decodePackEnvelope(raw);
		if (!envelopeResult.ok) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.envelopeInvalid', 'Неверный формат pack (decode): {0}', envelopeResult.reason) });
			return;
		}

		const computedHashes: ComputedHash[] = [];
		for (const entry of envelopeResult.value.entries) {
			try {
				const data = new TextEncoder().encode(entry.content);
				const hashBuf = await crypto.subtle.digest('SHA-256', data);
				const hex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
				computedHashes.push({ id: entry.id, sha256: hex });
			} catch (e) {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.hashError', 'Ошибка SHA-256 для {0}: {1}', entry.id, String(e)) });
				return;
			}
		}

		const incomingCommandsByPackId = new Map<string, ProjectCommandLite>();
		const incomingFull: ProjectCommand[] = [];
		const skippedUnsafe: string[] = [];
		for (const entry of envelopeResult.value.entries) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(entry.content);
			} catch (e) {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.contentParseError', 'Ошибка парсинга команды {0}: {1}', entry.id, (e as Error).message) });
				return;
			}
			if (!parsed || typeof (parsed as Record<string, unknown>).command !== 'string') {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.contentInvalid', 'Команда {0} в pack имеет неверный формат.', entry.id) });
				return;
			}
			const c = parsed as ProjectCommand;

			// L332: VibePromptGuardService — sanitize command/args before import.
			const sanitizeResult = sanitizeProjectCommand(c);
			if (!sanitizeResult.ok) {
				const firstIssue = describeIssue(sanitizeResult.issues[0]);
				skippedUnsafe.push(entry.id);
				notifications.notify({
					severity: Severity.Warning,
					message: localize('vibeide.commands.importFromUrl.unsafeSkipped', 'Команда {0} пропущена: {1}', entry.id, firstIssue),
				});
				continue;
			}

			incomingCommandsByPackId.set(entry.id, { id: entry.id, name: c.name, command: c.command, args: c.args, env: c.env, cwd: c.cwd });
			incomingFull.push({ ...c, id: entry.id });
		}

		if (incomingFull.length === 0 && skippedUnsafe.length > 0) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.allUnsafe', 'Все команды из pack пропущены из-за проблем безопасности.') });
			return;
		}

		const currentLite: ProjectCommandLite[] = commands.getCommands().map(c => ({ id: c.id, name: c.name, command: c.command, args: c.args, env: c.env, cwd: c.cwd }));

		const result = prepareCommandsPackImport({ raw, computedHashes, currentCommands: currentLite, incomingCommandsByPackId });
		if (result.kind === 'wrong-format') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.wrongFormat', 'Неподдерживаемый формат pack: {0}', result.actual) });
			return;
		}
		if (result.kind === 'envelope-invalid') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.envelopeInvalid2', 'Неверный формат pack: {0}', result.reason) });
			return;
		}
		if (result.kind === 'verify-failed') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.verifyFailed', 'SHA-256 верификация не пройдена: {0}{1}', result.reason, result.details ? ` (${result.details})` : '') });
			return;
		}
		if (result.kind === 'missing-incoming-command') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.missingCmd', 'Команда {0} объявлена в манифесте, но отсутствует в entries.', result.id) });
			return;
		}

		const dangerLine = result.diff.touchesSensitiveFields
			? `\n\n⚠️ ${localize('vibeide.commands.importFromUrl.danger', 'Изменяются поля command/args/env/cwd. Проверьте каждую строку перед подтверждением.')}`
			: '';
		const confirmed = await dialog.confirm({
			message: localize('vibeide.commands.importFromUrl.confirmTitle', 'VibeIDE: импорт project commands из URL'),
			detail: renderImportDiffMarkdown(result.diff) + dangerLine,
			primaryButton: localize('vibeide.commands.importFromUrl.confirmBtn', 'Импортировать'),
		});
		if (!confirmed.confirmed) return;

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.commands.importFromUrl.noWorkspace', 'Откройте рабочую папку для сохранения команд.') });
			return;
		}
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const dec = decodeProjectCommandsFile(JSON.parse(buf.value.toString()));
			if (dec.ok) existing = dec.value;
		} catch { /* missing → treated as empty */ }

		const merged: ProjectCommandsFile = { vibeVersion: existing?.vibeVersion ?? '1.0.0', commands: incomingFull };
		await fileService.writeFile(commandsUri, VSBuffer.fromString(JSON.stringify(merged, null, '\t') + '\n'));
		await commands.reload();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.importFromUrl.done', 'Импорт завершён: добавлено {0}, изменено {1}, удалено {2}.', result.diff.stats.added, result.diff.stats.modified, result.diff.stats.removed),
		});
	},
});

// ── vibeide.commands.add ────────────────────────────────────────────────────────
// Opens (or creates) .vibe/commands.json in the editor so the user can add a new command.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.add,
	handler: async (accessor: ServicesAccessor) => {
		const editorService = accessor.get(IEditorService);
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.commands.add.noWorkspace', 'Откройте рабочую папку для добавления команды.') });
			return;
		}
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		const exists = await fileService.exists(commandsUri);
		if (!exists) {
			await fileService.writeFile(commandsUri, VSBuffer.fromString(serializeProjectCommandsInitTemplate({ vibeVersion: '1.0.0' })));
		}
		await editorService.openEditor({ resource: commandsUri, options: { pinned: false } });
	},
});

// ── vibeide.commands.resetOnboarding ───────────────────────────────────────────
// Clears the vibeide onboarding completion flag so the welcome flow runs again.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.resetOnboarding,
	handler: async (accessor: ServicesAccessor) => {
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);

		const folder = workspace.getWorkspace().folders[0];
		if (folder) {
			const onboardingUri = joinPath(folder.uri, '.vibe', 'onboarding.json');
			try {
				await fileService.del(onboardingUri);
			} catch { /* already absent */ }
		}
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.resetOnboarding.done', 'Онбординг сброшен. Перезапустите VibeIDE для повторного показа.'),
		});
	},
});

// ── vibeide.commands.cancel ─────────────────────────────────────────────────────
// Quick Pick that lets the user cancel a running project command.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.cancel,
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		// The service does not expose a "running" list yet — show all commands and let user pick.
		const allCommands = commands.getCommands();
		if (allCommands.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.cancel.empty', 'Нет проектных команд.'),
			});
			return;
		}
		const items = allCommands.map(c => ({ label: c.name, description: c.id, commandId: c.id }));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.cancel.placeholder', 'Выберите команду для отмены (отменяет активную сессию в терминале)'),
		});
		if (!picked) return;
		// The run method re-runs; cancellation of a running terminal process is
		// handled by the terminal itself. Notify the user to use the terminal × button.
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.cancel.hint', 'Чтобы остановить активный процесс «{0}», нажмите × в панели Terminal.', picked.label),
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
	private readonly _chordRegistrations: IDisposable[] = [];
	private readonly _registrationStore = this._register(new DisposableStore());

	constructor(@IVibeCustomCommandsService private readonly _commands: IVibeCustomCommandsService) {
		super();
		void _commands.reload();

		// Initial pass + listen for FS changes. The service emits `init` on the
		// first reload — we wait for that, then re-bind on every subsequent
		// `fs-change | global-paths-change | manual-reload` event.
		this._rebindDynamicCommands(_commands.getCommands() as ReadonlyArray<{ id: string; pinned?: boolean; order?: number }>);
		this._register(_commands.onDidChangeCommands(e => this._rebindDynamicCommands(e.commands)));
	}

	private _rebindDynamicCommands(commands: ReadonlyArray<{ id: string; name?: string; pinned?: boolean; order?: number }>): void {
		// Dispose previous registrations. CommandsRegistry doesn't expose an
		// "unregister" API, but `registerCommand` returns an IDisposable that
		// removes the entry; we tracked them by registryId.
		for (const [, d] of this._dynamicRegistrations) {
			d.dispose();
		}
		this._dynamicRegistrations.clear();
		for (const d of this._chordRegistrations) {
			d.dispose();
		}
		this._chordRegistrations.length = 0;

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
				// `description` shows up in the Keyboard Shortcuts UI search
				// (`Project: <name>`) so users can find dynamic commands without
				// memorising the `vibeide.commands.run.<id>` prefix.
				metadata: { description: formatProjectCommandKeybindingLabel({ id: c.id, name: c.name ?? c.id }) },
			});
			this._dynamicRegistrations.set(registryId, d);
		}
		for (const d of this._dynamicRegistrations.values()) {
			this._registrationStore.add(d);
		}

		// Default chord keybindings (roadmap L339) for the top-9 pinned commands.
		// Pure helper allocates `ctrl+shift+alt+<1..9>` with user-overridable
		// `when: vibeide.commands.pinned >= N` clauses. Re-bind on every FS event
		// so adding / removing a pinned command updates the chord set.
		const chords = allocateDefaultChords(commands as ReadonlyArray<import('../common/projectCommandsTypes.js').ProjectCommand>);
		for (const chord of chords) {
			const keyCode = DIGIT_KEYS[chord.slot - 1];
			if (keyCode === undefined) {
				continue;
			}
			const d = KeybindingsRegistry.registerKeybindingRule({
				id: chord.registryId,
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyMod.Shift | KeyMod.Alt | keyCode,
				when: ContextKeyExpr.deserialize(chord.when),
			});
			this._chordRegistrations.push(d);
			this._registrationStore.add(d);
		}
	}
}

const DIGIT_KEYS: readonly KeyCode[] = [
	KeyCode.Digit1, KeyCode.Digit2, KeyCode.Digit3, KeyCode.Digit4, KeyCode.Digit5,
	KeyCode.Digit6, KeyCode.Digit7, KeyCode.Digit8, KeyCode.Digit9,
];

registerWorkbenchContribution2(VibeCustomCommandsContribution.ID, VibeCustomCommandsContribution, WorkbenchPhase.AfterRestored);
