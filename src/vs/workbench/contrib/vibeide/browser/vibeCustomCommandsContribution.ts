/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
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
import { CommandsRegistry, ICommandService } from '../../../../platform/commands/common/commands.js';
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
import { buildProjectCommandsInitTemplate, PROJECT_COMMANDS_INIT_EXAMPLE_ID, serializeProjectCommandsInitTemplate } from '../common/projectCommandsInitTemplate.js';
import { describeUnresolvedPlaceholders, findSuspiciousLiteralSecrets } from '../common/projectCommandSecretsResolver.js';
import { commandIdToRegistryId, formatProjectCommandKeybindingLabel } from '../common/projectCommandsRegistryId.js';
import { allocateDefaultChords } from '../common/projectCommandsKeybindings.js';
import { importTasksJson } from '../common/vscodeTasksJsonImporter.js';
import { sanitizeProjectCommand, describeIssue } from '../common/projectCommandsSanitizer.js';
import { decodeProjectCommandsFile, ProjectCommandsFile, ProjectCommand, PROJECT_COMMAND_ID_PATTERN } from '../common/projectCommandsTypes.js';
import {
	ADD_COMMAND_DRAFT_EMPTY,
	AddCommandDraft,
	appendCommandToFile,
	buildProjectCommandFromDraft,
	commandToDraft,
	removeCommandFromFile,
	validateAddCommandDraft,
	ADD_COMMAND_ERROR,
} from '../common/projectCommandsAddFormPolicy.js';
import { VIBE_WORKSPACE_FORMAT_VERSION } from '../common/vibeDefaultWorkspaceReadme.js';
import { IVibeProjectCommandFormModalService } from '../common/vibeProjectCommandFormModalService.js';
import { safeParseConfigJson } from '../common/vibeConfigJsonParser.js';
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
		// L304: JSONC-tolerant parse — VS Code tasks.json carries `//` comments by convention.
		const tasksParse = safeParseConfigJson(tasksBuf.value.toString());
		if (!tasksParse.ok) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.importTasksJson.parseFailed', 'tasks.json: ошибка JSON: {0}', tasksParse.reason),
			});
			return;
		}

		const preview = importTasksJson(tasksParse.value);
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

		// L332 sanitiser gate + L914 secret-aware filter: refuse imports with
		// zero-width / Bidi / control / shell-metachar issues OR plaintext-looking
		// secrets in command/args/env before they reach the Quick Pick.
		const unsafe: { name: string; reason: string }[] = [];
		const safeImports = preview.imported.filter(({ command }) => {
			const sanResult = sanitizeProjectCommand(command);
			if (!sanResult.ok) {
				unsafe.push({ name: command.name, reason: describeIssue(sanResult.issues[0]) });
				return false;
			}
			const suspects = findSuspiciousLiteralSecrets({
				command: command.command,
				args: command.args,
				cwd: command.cwd,
				env: command.env,
			});
			if (suspects.length > 0) {
				unsafe.push({
					name: command.name,
					reason: localize(
						'vibeide.commands.importTasksJson.secretSuspect',
						'подозрение на plaintext-секрет в {0} — используйте ${secret:KEY}',
						suspects[0].pathHint,
					),
				});
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
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) {
					existing = decoded.value;
				}
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
		if (!picked) { return; }

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) { return; }
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
		if (!picked) { return; }

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) { return; }
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let raw: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) { raw = decoded.value; }
			}
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
		if (!picked) { return; }
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
				{
					placeHolder: targetPinned
						? localize('vibeide.commands.pin.placeholder', 'Выберите команду, чтобы закрепить')
						: localize('vibeide.commands.unpin.placeholder', 'Выберите команду, чтобы открепить'),
				},
			);
			if (!picked) {
				return;
			}

			const folder = workspace.getWorkspace().folders[0];
			if (!folder) { return; }
			const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
			let raw: ProjectCommandsFile | null = null;
			try {
				const buf = await fileService.readFile(commandsUri);
				const parsed = safeParseConfigJson(buf.value.toString());
				if (parsed.ok) {
					const decoded = decodeProjectCommandsFile(parsed.value);
					if (decoded.ok) { raw = decoded.value; }
				}
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
		if (!picked) { return; }

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
				if (!t) { return null; }
				if (!t.startsWith('https://')) { return localize('vibeide.commands.importFromUrl.notHttps', 'Разрешены только HTTPS URL.'); }
				return null;
			},
		});
		if (!rawUrl?.trim()) { return; }
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
			const parsed = safeParseConfigJson(entry.content);
			if (!parsed.ok) {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.contentParseError', 'Ошибка парсинга команды {0}: {1}', entry.id, parsed.reason) });
				return;
			}
			if (!parsed.value || typeof (parsed.value as Record<string, unknown>).command !== 'string') {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.commands.importFromUrl.contentInvalid', 'Команда {0} в pack имеет неверный формат.', entry.id) });
				return;
			}
			const c = parsed.value as ProjectCommand;

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

			// L914: refuse import of commands carrying plaintext-looking secrets.
			const suspects = findSuspiciousLiteralSecrets({ command: c.command, args: c.args, cwd: c.cwd, env: c.env });
			if (suspects.length > 0) {
				skippedUnsafe.push(entry.id);
				notifications.notify({
					severity: Severity.Warning,
					message: localize(
						'vibeide.commands.importFromUrl.secretSuspect',
						'Команда {0} пропущена — подозрение на plaintext-секрет в {1}. Используйте ${secret:KEY}.',
						entry.id, suspects[0].pathHint,
					),
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
		if (!confirmed.confirmed) { return; }

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.commands.importFromUrl.noWorkspace', 'Откройте рабочую папку для сохранения команд.') });
			return;
		}
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const dec = decodeProjectCommandsFile(parsed.value);
				if (dec.ok) { existing = dec.value; }
			}
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
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.commands.import.noWorkspace', 'Откройте рабочую папку для добавления команды.') });
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

// ── vibeide.commands.list ───────────────────────────────────────────────────────
// Quick Pick listing every loaded project command with id, name, pin state, and
// the resolved shell line. Selecting an entry runs the command (parity with
// `vibeide.commands.runFromPalette` but with a richer detail line so the user
// can browse what's defined without opening JSON).
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.list',
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize(
					'vibeide.commands.list.empty',
					'Команд нет. Используйте «VibeIDE: Open .vibe/commands.json» чтобы добавить первую.',
				),
			});
			return;
		}

		const items = list.map(c => {
			const argSuffix = (c.args && c.args.length > 0) ? ' ' + c.args.join(' ') : '';
			return {
				label: c.pinned ? `$(pin) ${c.name}` : c.name,
				description: c.id,
				detail: `${c.command}${argSuffix}${c.cwd ? `  ·  cwd: ${c.cwd}` : ''}`,
				commandId: c.id,
			};
		});

		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.list.placeholder', 'Project Commands — {0} шт.', list.length),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) {
			return;
		}
		const outcome = await commands.run(picked.commandId);
		if (outcome.outcome === 'refused' || outcome.outcome === 'failure') {
			notifications.notify({
				severity: outcome.outcome === 'refused' ? Severity.Warning : Severity.Error,
				message: localize('vibeide.commands.list.failed', 'Команда «{0}»: {1}', picked.label, outcome.reason ?? 'unknown'),
			});
		}
	},
});

// ── vibeide.commands.add ───────────────────────────────────────────────────────
// Opens the Add/Edit form in a resizable modal (`VibeProjectCommandFormModal`) in 'add' mode.
// Form lives in `VibeProjectCommandForm.tsx` — see that file for validation and write logic.
CommandsRegistry.registerCommand({
	id: PROJECT_COMMANDS_PALETTE_IDS.add,
	handler: async (accessor: ServicesAccessor) => {
		const formModal = accessor.get(IVibeProjectCommandFormModalService);
		const notifications = accessor.get(INotificationService);
		const workspace = accessor.get(IWorkspaceContextService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.add.noWorkspace', 'Откройте папку, чтобы добавить проектную команду.'),
			});
			return;
		}

		formModal.open({ mode: 'add' });
	},
});

// ── vibeide.commands.editById ─────────────────────────────────────────────────
// Opens the standalone Add/Edit form in 'edit' mode, prefilled from the
// existing workspace command. Workspace-source only — global-source commands
// fall back to a notification.
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.editById',
	handler: async (accessor: ServicesAccessor, commandId: string) => {
		const formModal = accessor.get(IVibeProjectCommandFormModalService);
		const notifications = accessor.get(INotificationService);
		const workspace = accessor.get(IWorkspaceContextService);
		const fileService = accessor.get(IFileService);

		if (typeof commandId !== 'string' || !commandId) { return; }
		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.edit.noWorkspace', 'Откройте папку, чтобы редактировать проектную команду.'),
			});
			return;
		}

		// Read commands.json from disk so we get the on-disk shape, not the merged
		// snapshot (which can include global-source entries with the same id).
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existingCmd: ProjectCommand | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) {
					existingCmd = decoded.value.commands.find(c => c.id === commandId) ?? null;
				}
			}
		} catch { /* missing file — handled below */ }

		if (!existingCmd) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.edit.missing', 'Команда «{0}» не найдена в workspace .vibe/commands.json (возможно, она из global-источника — редактируйте исходный файл).', commandId),
			});
			return;
		}

		formModal.open({
			mode: 'edit',
			commandIdForEdit: commandId,
			initialDraft: commandToDraft(existingCmd),
		});
	},
});

// ── vibeide.commands.deleteById ───────────────────────────────────────────────
// Confirm + remove. Workspace-source only.
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.deleteById',
	handler: async (accessor: ServicesAccessor, commandId: string) => {
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);
		const commands = accessor.get(IVibeCustomCommandsService);

		if (typeof commandId !== 'string' || !commandId) { return; }
		const folder = workspace.getWorkspace().folders[0];
		if (!folder) { return; }

		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) { existing = decoded.value; }
			}
		} catch { /* missing → treated as empty */ }

		const cmd = existing?.commands.find(c => c.id === commandId) ?? null;
		if (!cmd || !existing) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.delete.missing', 'Команда «{0}» не найдена в workspace .vibe/commands.json (возможно, она из global-источника).', commandId),
			});
			return;
		}

		const confirm = await dialogService.confirm({
			message: localize('vibeide.commands.delete.title', 'Удалить команду «{0}»?', cmd.name),
			detail: localize('vibeide.commands.delete.detail', 'Запись будет удалена из .vibe/commands.json. Откатить можно только через git.'),
			primaryButton: localize('vibeide.commands.delete.ok', 'Удалить'),
			type: 'warning',
		});
		if (!confirm.confirmed) { return; }

		const removed = removeCommandFromFile(existing, commandId);
		if (!removed) { return; }
		try {
			await fileService.writeFile(commandsUri, VSBuffer.fromString(removed.serialized));
		} catch (e) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.delete.writeFailed', 'Не удалось записать .vibe/commands.json: {0}', String((e as Error)?.message ?? e)),
			});
			return;
		}
		await commands.reload();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.delete.done', 'Команда «{0}» удалена.', cmd.name),
		});
	},
});

// ── vibeide.commands.editPick / deletePick ────────────────────────────────────
// Quick Pick over the merged command snapshot — selected id dispatches to
// `editById` / `deleteById` respectively. Used as the menubar entry-point
// because flat MenuItems (no submenu) can't expose two actions per row.
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.editPick',
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.editPick.empty', 'Нет команд для редактирования. Используйте «+ Добавить команду…» или «↻ Восстановить демо-команду».'),
			});
			return;
		}
		const items = list.map(c => ({
			label: c.pinned ? `$(pin) ${c.name}` : c.name,
			description: c.id,
			detail: (c.args && c.args.length) ? `${c.command} ${c.args.join(' ')}` : c.command,
			commandId: c.id,
		}));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.editPick.placeholder', 'Выберите команду для редактирования'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) { return; }
		await commandService.executeCommand('vibeide.commands.editById', picked.commandId);
	},
});

CommandsRegistry.registerCommand({
	id: 'vibeide.commands.deletePick',
	handler: async (accessor: ServicesAccessor) => {
		const commands = accessor.get(IVibeCustomCommandsService);
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const commandService = accessor.get(ICommandService);

		const list = commands.getCommands();
		if (list.length === 0) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.deletePick.empty', 'Нет команд для удаления.'),
			});
			return;
		}
		const items = list.map(c => ({
			label: c.pinned ? `$(pin) ${c.name}` : c.name,
			description: c.id,
			detail: (c.args && c.args.length) ? `${c.command} ${c.args.join(' ')}` : c.command,
			commandId: c.id,
		}));
		const picked = await quickInput.pick(items, {
			placeHolder: localize('vibeide.commands.deletePick.placeholder', 'Выберите команду для удаления'),
			matchOnDescription: true,
			matchOnDetail: true,
		});
		if (!picked) { return; }
		await commandService.executeCommand('vibeide.commands.deleteById', picked.commandId);
	},
});

// ── vibeide.commands.seedDemo ─────────────────────────────────────────────────
// Seeds `.vibe/commands.json` with the canonical example command (the one
// `vibeConfigInitService` writes on first workspace open). Useful when the
// file already exists from a prior session, the user emptied the array, or
// the demo was deleted — without this they can't "see what a Project Command
// looks like" without reading docs.
//
// Behaviour:
//   - file missing  → write init template verbatim.
//   - file exists, no `example` id → append the example entry.
//   - file exists, has `example` id → no-op + info notification.
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.seedDemo',
	handler: async (accessor: ServicesAccessor) => {
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);
		const commands = accessor.get(IVibeCustomCommandsService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.seedDemo.noWorkspace', 'Откройте папку, чтобы создать демо-команду.'),
			});
			return;
		}

		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile | null = null;
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) { existing = decoded.value; }
			}
		} catch { /* missing — handled below */ }

		const template = buildProjectCommandsInitTemplate({ vibeVersion: VIBE_WORKSPACE_FORMAT_VERSION });
		const example = template.commands[0];

		if (!existing) {
			// Use the full RU-commented init template when the file is missing —
			// keeps the on-disk shape identical to fresh `vibeConfigInitService` runs.
			try {
				await fileService.writeFile(commandsUri, VSBuffer.fromString(serializeProjectCommandsInitTemplate({ vibeVersion: VIBE_WORKSPACE_FORMAT_VERSION })));
			} catch (e) {
				notifications.notify({
					severity: Severity.Error,
					message: localize('vibeide.commands.seedDemo.writeFailed', 'Не удалось создать .vibe/commands.json: {0}', String((e as Error)?.message ?? e)),
				});
				return;
			}
			await commands.reload();
			notifications.notify({ severity: Severity.Info, message: localize('vibeide.commands.seedDemo.created', 'Создан .vibe/commands.json с демо-командой «{0}».', example.name) });
			return;
		}

		if (existing.commands.some(c => c.id === PROJECT_COMMANDS_INIT_EXAMPLE_ID)) {
			notifications.notify({
				severity: Severity.Info,
				message: localize('vibeide.commands.seedDemo.alreadyExists', 'Демо-команда «{0}» уже есть в .vibe/commands.json.', example.name),
			});
			return;
		}

		const { serialized } = appendCommandToFile(existing, example);
		try {
			await fileService.writeFile(commandsUri, VSBuffer.fromString(serialized));
		} catch (e) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.seedDemo.appendFailed', 'Не удалось записать .vibe/commands.json: {0}', String((e as Error)?.message ?? e)),
			});
			return;
		}
		await commands.reload();
		notifications.notify({ severity: Severity.Info, message: localize('vibeide.commands.seedDemo.appended', 'Демо-команда «{0}» добавлена в .vibe/commands.json.', example.name) });
	},
});

// Legacy multi-step QuickInput Add handler (kept as a fallback under a separate
// id — palette/menubar still resolve to the editor-based handler above).
CommandsRegistry.registerCommand({
	id: 'vibeide.commands.addViaQuickInput',
	handler: async (accessor: ServicesAccessor) => {
		const quickInput = accessor.get(IQuickInputService);
		const notifications = accessor.get(INotificationService);
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const commands = accessor.get(IVibeCustomCommandsService);

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.add.noWorkspace', 'Откройте папку, чтобы добавить проектную команду.'),
			});
			return;
		}

		const existingIds = new Set(commands.getCommands().map(c => c.id));

		// Prompt-with-validation helper. `validate` is called per-keystroke; non-null
		// return value disables `accept`. Cancel via Esc returns undefined.
		const ask = async (
			value: string,
			placeholder: string,
			prompt: string,
			step: number,
			totalSteps: number,
			validate?: (v: string) => string | null,
		): Promise<string | undefined> => {
			const box = quickInput.createInputBox();
			box.title = localize('vibeide.commands.add.title', 'Новая команда .vibe/commands.json');
			box.step = step;
			box.totalSteps = totalSteps;
			box.value = value;
			box.placeholder = placeholder;
			box.prompt = prompt;
			box.ignoreFocusOut = true;
			if (validate) {
				const err = validate(value);
				box.validationMessage = err ?? undefined;
				box.onDidChangeValue(v => {
					box.validationMessage = validate(v) ?? undefined;
				});
			}
			try {
				return await new Promise<string | undefined>(resolve => {
					box.onDidAccept(() => {
						if (validate) {
							const err = validate(box.value);
							if (err) { box.validationMessage = err; return; }
						}
						resolve(box.value);
					});
					box.onDidHide(() => resolve(undefined));
					box.show();
				});
			} finally {
				box.dispose();
			}
		};

		const askPick = async <T>(
			items: { label: string; description?: string; value: T }[],
			placeholder: string,
			_step: number,
			_totalSteps: number,
		): Promise<T | undefined> => {
			// `quickInput.pick` returns the picked item itself (or undefined on Esc);
			// `ignoreFocusLost` is the option name on the multi-overload signature.
			const picked = await quickInput.pick(items, { placeHolder: placeholder, ignoreFocusLost: true });
			return picked ? picked.value : undefined;
		};

		const TOTAL = 8;
		const draft: { -readonly [K in keyof AddCommandDraft]: AddCommandDraft[K] } = { ...ADD_COMMAND_DRAFT_EMPTY };

		const idErrLabel = (code: string | null): string | null => {
			switch (code) {
				case ADD_COMMAND_ERROR.idMissing: return localize('vibeide.commands.add.err.idMissing', 'id обязателен');
				case ADD_COMMAND_ERROR.idPattern: return localize('vibeide.commands.add.err.idPattern', 'id: только латиница в нижнем регистре, цифры и дефисы; начинается с буквы/цифры; до 64 символов');
				case ADD_COMMAND_ERROR.idDuplicate: return localize('vibeide.commands.add.err.idDuplicate', 'команда с таким id уже существует');
				case ADD_COMMAND_ERROR.cwdAbsolute: return localize('vibeide.commands.add.err.cwdAbsolute', 'cwd должен быть относительным путём от корня workspace');
				case ADD_COMMAND_ERROR.cwdTraversal: return localize('vibeide.commands.add.err.cwdTraversal', 'cwd не должен содержать «..»');
				case ADD_COMMAND_ERROR.orderNotNumber: return localize('vibeide.commands.add.err.orderNotNumber', 'order должен быть целым числом');
				default: return null;
			}
		};

		// Step 1: id
		const id = await ask(
			'', 'lint, deploy-dev, run-tests…',
			localize('vibeide.commands.add.idPrompt', 'Уникальный id команды (латиница, цифры, дефисы; ≤64).'),
			1, TOTAL,
			v => {
				const trimmed = v.trim();
				if (!trimmed) { return idErrLabel(ADD_COMMAND_ERROR.idMissing); }
				if (!PROJECT_COMMAND_ID_PATTERN.test(trimmed)) { return idErrLabel(ADD_COMMAND_ERROR.idPattern); }
				if (existingIds.has(trimmed)) { return idErrLabel(ADD_COMMAND_ERROR.idDuplicate); }
				return null;
			},
		);
		if (id === undefined) { return; }
		draft.id = id.trim();

		// Step 2: name
		const name = await ask(
			'', 'Run lint, Deploy dev, …',
			localize('vibeide.commands.add.namePrompt', 'Отображаемое имя — будет видно в палитре и на кнопке статус-бара.'),
			2, TOTAL,
			v => v.trim() ? null : localize('vibeide.commands.add.err.nameMissing', 'Имя обязательно'),
		);
		if (name === undefined) { return; }
		draft.name = name.trim();

		// Step 3: description
		const description = await ask(
			'', localize('vibeide.commands.add.descPlaceholder', 'Опционально (для тултипа)'),
			localize('vibeide.commands.add.descPrompt', 'Краткое описание команды.'),
			3, TOTAL,
		);
		if (description === undefined) { return; }
		draft.description = description;

		// Step 4: command
		const command = await ask(
			'', 'npm, docker, python, …',
			localize('vibeide.commands.add.commandPrompt', 'Исполняемый файл (без аргументов).'),
			4, TOTAL,
			v => v.trim() ? null : localize('vibeide.commands.add.err.commandMissing', 'Команда обязательна'),
		);
		if (command === undefined) { return; }
		draft.command = command.trim();

		// Step 5: args — single-line, comma-or-space separated, converted to newline-separated for the draft.
		const argsLine = await ask(
			'', 'run lint  (через пробел или запятую)',
			localize('vibeide.commands.add.argsPrompt', 'Аргументы (через пробел или запятую). Пустое поле — без аргументов.'),
			5, TOTAL,
		);
		if (argsLine === undefined) { return; }
		draft.argsText = argsLine
			.split(/[,\s]+/)
			.map(s => s.trim())
			.filter(s => s.length > 0)
			.join('\n');

		// Step 6: cwd
		const cwd = await ask(
			'', localize('vibeide.commands.add.cwdPlaceholder', 'Относительно корня workspace; пусто — корень.'),
			localize('vibeide.commands.add.cwdPrompt', 'Рабочая папка (cwd).'),
			6, TOTAL,
			v => {
				const trimmed = v.trim();
				if (!trimmed) { return null; }
				if (trimmed.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(trimmed)) { return idErrLabel(ADD_COMMAND_ERROR.cwdAbsolute); }
				if (trimmed.split(/[\\/]+/).some(s => s === '..')) { return idErrLabel(ADD_COMMAND_ERROR.cwdTraversal); }
				return null;
			},
		);
		if (cwd === undefined) { return; }
		draft.cwd = cwd;

		// Step 7: terminal — quickPick
		const terminal = await askPick<'integrated' | 'external' | 'background' | ''>(
			[
				{ label: localize('vibeide.commands.add.term.integrated', 'Встроенный терминал'), description: 'integrated', value: 'integrated' },
				{ label: localize('vibeide.commands.add.term.external', 'Внешняя консоль'), description: 'external', value: 'external' },
				{ label: localize('vibeide.commands.add.term.background', 'Фоновый процесс'), description: 'background', value: 'background' },
			],
			localize('vibeide.commands.add.terminalPrompt', 'Шаг 7/8: где запускать команду'),
			7, TOTAL,
		);
		if (terminal === undefined) { return; }
		draft.terminal = terminal;

		// Step 8: pinned — quickPick
		const pinned = await askPick<boolean>(
			[
				{ label: localize('vibeide.commands.add.pin.no', 'Не закреплять'), description: localize('vibeide.commands.add.pin.noHint', 'Доступно через палитру и из menubar'), value: false },
				{ label: localize('vibeide.commands.add.pin.yes', 'Закрепить в статус-баре'), description: localize('vibeide.commands.add.pin.yesHint', 'Кнопка в статус-баре (с учётом лимита maxPinned)'), value: true },
			],
			localize('vibeide.commands.add.pinPrompt', 'Шаг 8/8: закрепление'),
			8, TOTAL,
		);
		if (pinned === undefined) { return; }
		draft.pinned = pinned;

		const validation = validateAddCommandDraft(draft, existingIds);
		if (!validation.isValid) {
			notifications.notify({
				severity: Severity.Warning,
				message: localize('vibeide.commands.add.invalid', 'Не сохранено — проверьте поля и попробуйте снова.'),
			});
			return;
		}

		const newCmd = buildProjectCommandFromDraft(draft);
		const commandsUri = joinPath(folder.uri, '.vibe', 'commands.json');
		let existing: ProjectCommandsFile = { vibeVersion: VIBE_WORKSPACE_FORMAT_VERSION, commands: [] };
		try {
			const buf = await fileService.readFile(commandsUri);
			const parsed = safeParseConfigJson(buf.value.toString());
			if (parsed.ok) {
				const decoded = decodeProjectCommandsFile(parsed.value);
				if (decoded.ok) { existing = decoded.value; }
			}
		} catch {
			// File missing — start fresh.
		}

		const { serialized } = appendCommandToFile(existing, newCmd);
		try {
			await fileService.writeFile(commandsUri, VSBuffer.fromString(serialized));
		} catch (e) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.commands.add.writeFailed', 'Не удалось записать .vibe/commands.json: {0}', String((e as Error)?.message ?? e)),
			});
			return;
		}
		await commands.reload();
		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.commands.add.done', 'Команда «{0}» добавлена в .vibe/commands.json.', newCmd.name),
		});
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
		if (!picked) { return; }
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
