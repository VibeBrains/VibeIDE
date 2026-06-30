/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { Action2, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize, localize2 } from '../../../../nls.js';
import { IChatThreadService, ThreadType } from './chatThreadService.js';
import { ChatMessage } from '../common/chatThreadServiceTypes.js';
import { IFileDialogService, IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { URI } from '../../../../base/common/uri.js';

// CH.7 — bulk-claim legacy (untagged) chat threads onto the current project.
// Companion to the per-thread "move to this project" hover action; useful as a
// one-shot migration for users upgrading from the pre-scoping global history.
registerAction2(class ClaimUntaggedThreadsAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.history.claimUntaggedThreads',
			title: localize2('vibeide.history.claimUntaggedThreads', 'Привязать историю без проекта к текущему'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);

		const claimed = chatThreadService.claimUntaggedThreadsForCurrentWorkspace();
		notificationService.notify({
			severity: Severity.Info,
			message: claimed > 0
				? localize('vibeide.history.claimUntaggedThreads.done', 'Привязано к текущему проекту: {0} чатов без проекта.', claimed)
				: localize('vibeide.history.claimUntaggedThreads.noop', 'Нет чатов без проекта — привязывать нечего.'),
		});
	}
});

// CH.13 helpers — serialize a project's threads for export.

const safeSlug = (s: string): string => (s || 'project').replace(/[^a-zA-Z0-9._-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'project';

// Extract the user-visible body of a message, regardless of role variant.
// Mirrors the legacy `displayContent || content || ''` precedence: user/assistant
// expose `displayContent`, tool exposes `content`, and structural messages
// (plan/review/checkpoint/interrupted) have no body text.
const messageBodyText = (m: ChatMessage): string => {
	switch (m.role) {
		case 'user': return m.displayContent || m.content;
		case 'assistant': return m.displayContent;
		case 'tool': return m.content;
		default: return '';
	}
};

const threadTitle = (t: ThreadType): string => {
	const fu = t.messages.find(m => m.role === 'user');
	const text = (fu ? messageBodyText(fu) : '').replace(/\s+/g, ' ').trim();
	return text ? (text.length > 80 ? text.slice(0, 80) + '…' : text) : t.id;
};

const threadsToJson = (threads: ThreadType[], project: string): string => {
	// Replacer drops runtime-only noise and lossy types so the export is clean
	// and portable: `mountedInfo` is a live Promise + resolver fns (serialize to
	// `{}`/dropped), Sets (filesWithUserChanges) would silently become `{}`, and
	// raw image bytes would bloat the file — keep a size placeholder instead.
	const replacer = (key: string, value: unknown): unknown => {
		if (key === 'mountedInfo') { return undefined; }
		if (value instanceof Set) { return Array.from(value); }
		if (value instanceof Uint8Array) { return `__bytes__:${value.length}`; }
		return value;
	};
	const payload = {
		meta: { schema: 1, exportedAt: new Date().toISOString(), project, threadCount: threads.length },
		threads,
	};
	return JSON.stringify(payload, replacer, 2);
};

const threadsToMarkdown = (threads: ThreadType[], project: string): string => {
	const lines: string[] = [`# VibeIDE — история чата: ${project}`, '', `> Экспортировано: ${new Date().toISOString()} · тредов: ${threads.length}`, ''];
	for (const t of threads) {
		lines.push(`## ${threadTitle(t)}`, '', `<sub>${t.lastModified}</sub>`, '');
		for (const m of t.messages) {
			const body = messageBodyText(m).trim();
			if (!body && m.role !== 'user' && m.role !== 'assistant') { continue; }
			lines.push(`**${m.role}:** ${body}`, '');
		}
		lines.push('---', '');
	}
	return lines.join('\n');
};

// CH.13 — export the current project's chat history to a JSON or Markdown file.
registerAction2(class ExportProjectHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.history.exportProject',
			title: localize2('vibeide.history.exportProject', 'Экспортировать историю текущего проекта'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);
		const quickInput = accessor.get(IQuickInputService);
		const fileDialogService = accessor.get(IFileDialogService);
		const fileService = accessor.get(IFileService);

		const threads = chatThreadService.getCurrentWorkspaceThreads();
		if (threads.length === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.history.exportProject.empty', 'У текущего проекта нет истории чатов для экспорта.') });
			return;
		}

		const fmt = await quickInput.pick(
			[
				{ label: 'Markdown (.md)', id: 'md', description: localize('vibeide.history.exportProject.md', 'Читаемая стенограмма') },
				{ label: 'JSON (.json)', id: 'json', description: localize('vibeide.history.exportProject.json', 'Полные данные тредов') },
			],
			{ placeHolder: localize('vibeide.history.exportProject.format', 'Формат экспорта истории ({0} тредов)', threads.length) }
		);
		if (!fmt) { return; }
		const isMd = (fmt as { id: string }).id === 'md';

		const project = safeSlug(threads.find(t => t.workspaceLabel)?.workspaceLabel ?? 'project');
		const date = new Date().toISOString().slice(0, 10);
		const ext = isMd ? 'md' : 'json';
		const fileName = `vibeide-history-${project}-${date}.${ext}`;

		const baseDir = await fileDialogService.defaultFilePath();
		const target = await fileDialogService.showSaveDialog({
			title: localize('vibeide.history.exportProject.save', 'Сохранить историю проекта'),
			defaultUri: baseDir ? URI.joinPath(baseDir, fileName) : undefined,
			filters: isMd ? [{ name: 'Markdown', extensions: ['md'] }] : [{ name: 'JSON', extensions: ['json'] }],
		});
		if (!target) { return; }

		const content = isMd
			? threadsToMarkdown(threads, project)
			: threadsToJson(threads, project);
		try {
			await fileService.writeFile(target, VSBuffer.fromString(content));
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.history.exportProject.done', 'История экспортирована: {0} тредов → {1}', threads.length, target.fsPath) });
		} catch (e) {
			notificationService.notify({ severity: Severity.Error, message: localize('vibeide.history.exportProject.fail', 'Не удалось записать файл экспорта: {0}', String(e)) });
		}
	}
});

// CH.13 — delete all chat history strictly owned by the current project (confirmed).
registerAction2(class ClearProjectHistoryAction extends Action2 {
	constructor() {
		super({
			id: 'vibeide.history.clearProject',
			title: localize2('vibeide.history.clearProject', 'Удалить историю текущего проекта'),
			f1: true,
			category: { value: 'VibeIDE', original: 'VibeIDE' },
		});
	}

	async run(accessor: ServicesAccessor): Promise<void> {
		const chatThreadService = accessor.get(IChatThreadService);
		const notificationService = accessor.get(INotificationService);
		const dialogService = accessor.get(IDialogService);

		const count = chatThreadService.getCurrentWorkspaceThreads().length;
		if (count === 0) {
			notificationService.notify({ severity: Severity.Info, message: localize('vibeide.history.clearProject.empty', 'У текущего проекта нет истории чатов для удаления.') });
			return;
		}

		const { confirmed } = await dialogService.confirm({
			type: 'warning',
			message: localize('vibeide.history.clearProject.confirm', 'Удалить всю историю чатов текущего проекта ({0} тредов)?', count),
			detail: localize('vibeide.history.clearProject.detail', 'Затрагиваются только треды, принадлежащие этому проекту. История без проекта и других проектов не трогается. Действие необратимо — рекомендуется сначала экспортировать.'),
			primaryButton: localize('vibeide.history.clearProject.primary', 'Удалить'),
		});
		if (!confirmed) { return; }

		const deleted = chatThreadService.deleteCurrentWorkspaceThreads();
		notificationService.notify({ severity: Severity.Info, message: localize('vibeide.history.clearProject.done', 'Удалено тредов текущего проекта: {0}.', deleted) });
	}
});
