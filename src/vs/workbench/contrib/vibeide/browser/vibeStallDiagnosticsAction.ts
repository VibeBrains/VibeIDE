/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * `vibeide.chat.collectStallDiagnostics` — one-click capture of the silent-stream-stall report.
 *
 * Triggered from the hard-stall error banner ("Собрать диагностику") and auto-fired when the user
 * armed diagnostic mode via "Повторить с диагностикой". Bundles the chat-run trace timeline + stall
 * context + live transport generation into a markdown file the user can drop straight into chat, and
 * offers to also produce the full crash-report ZIP for network-level detail.
 */

import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { ICommandService } from '../../../../platform/commands/common/commands.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IClipboardService } from '../../../../platform/clipboard/common/clipboardService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService } from './chatThreadService.js';
import { ILLMMessageService } from '../common/sendLLMMessageService.js';
import { getChatTrace, renderChatTraceMarkdown } from './vibeChatRunTrace.js';
import { buildStallReportMarkdown, StallReportTransport } from './vibeStallDiagnostics.js';

export const VIBE_COLLECT_STALL_DIAGNOSTICS_ID = 'vibeide.chat.collectStallDiagnostics';
const BUNDLE_CRASH_REPORT_ID = 'vibeide.watchdog.bundleCrashReport';

class VibeCollectStallDiagnosticsAction extends Action2 {
	constructor() {
		super({
			id: VIBE_COLLECT_STALL_DIAGNOSTICS_ID,
			title: localize2('vibeide.chat.collectStallDiagnostics.title', 'Собрать диагностику зависания стрима'),
			category: { value: 'VibeIDE Diagnostics', original: 'VibeIDE Diagnostics' },
			f1: true,
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const llm = accessor.get(ILLMMessageService);
		const fileService = accessor.get(IFileService);
		const fileDialog = accessor.get(IFileDialogService);
		const workspace = accessor.get(IWorkspaceContextService);
		const clipboard = accessor.get(IClipboardService);
		const editor = accessor.get(IEditorService);
		const notifications = accessor.get(INotificationService);
		const product = accessor.get(IProductService);
		const commandService = accessor.get(ICommandService);

		const threadId = chatThreadService.getCurrentThread().id;
		const context = chatThreadService.getStallDiagnosticsContext(threadId);

		let transport: StallReportTransport | undefined;
		try {
			transport = await llm.getTransportDiagnostics();
		} catch {
			// transport snapshot is best-effort — the renderer-side timeline is the primary signal
		}

		const capturedAtIso = new Date().toISOString();
		const md = buildStallReportMarkdown({
			context,
			transport,
			traceMarkdown: renderChatTraceMarkdown(getChatTrace()),
			capturedAtIso,
			appName: product.nameShort,
			appVersion: (product as unknown as { vibeVersion?: string }).vibeVersion ?? product.version,
		});

		// Filename-safe timestamp (no colons — invalid on Windows).
		const stamp = capturedAtIso.replace(/[:.]/g, '-');
		const fileName = `stall-${stamp}.md`;

		// Prefer a one-click write into the workspace; fall back to a save dialog when there is no folder.
		const folder = workspace.getWorkspace().folders[0]?.uri;
		let target: URI | undefined;
		if (folder) {
			const dir = joinPath(folder, '.vibe', 'diagnostics');
			try {
				await fileService.createFolder(dir);
				target = joinPath(dir, fileName);
			} catch {
				target = undefined;
			}
		}
		if (!target) {
			const defaultFolder = await fileDialog.defaultFilePath('file');
			const defaultUri = defaultFolder ? joinPath(defaultFolder, fileName) : undefined;
			target = await fileDialog.showSaveDialog({
				title: localize('vibeide.chat.collectStallDiagnostics.save', 'Сохранить отчёт о зависании'),
				defaultUri,
				filters: [{ name: 'Markdown', extensions: ['md'] }],
			});
			if (!target) { return; }
		}

		try {
			await fileService.writeFile(target, VSBuffer.fromString(md));
		} catch (e) {
			notifications.notify({
				severity: Severity.Error,
				message: localize('vibeide.chat.collectStallDiagnostics.failed', 'Не удалось сохранить отчёт: {0}', e instanceof Error ? e.message : String(e)),
			});
			return;
		}

		await clipboard.writeText(target.fsPath);
		await editor.openEditor({ resource: target, options: { pinned: true } });

		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.chat.collectStallDiagnostics.done', 'Отчёт о зависании сохранён, путь скопирован в буфер: {0}. Можно приложить его в чат.', target.fsPath),
			actions: {
				primary: [{
					id: 'vibeide.chat.collectStallDiagnostics.alsoZip',
					label: localize('vibeide.chat.collectStallDiagnostics.alsoZip', 'Собрать ещё и crash-report ZIP'),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: () => { void commandService.executeCommand(BUNDLE_CRASH_REPORT_ID); },
				}],
			},
		});
	}
}

registerAction2(VibeCollectStallDiagnosticsAction);
