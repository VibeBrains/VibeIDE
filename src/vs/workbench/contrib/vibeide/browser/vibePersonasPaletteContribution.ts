/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Personas marketplace palette commands (roadmap §L1052).
 *
 * Mirrors the community-commands import pipeline (vibeCustomCommandsContribution.ts §L343)
 * for personas packs (`vibe-community-personas-pack-v1`):
 *   URL input → HTTPS fetch → SHA-256 verify → diff confirm dialog → write .vibe/personas/<id>/persona.md
 *
 * The write step uses IFileService directly — no persona catalog service required.
 * Each pack entry's `content` field is written verbatim as the persona markdown file.
 */

import { ServicesAccessor } from '../../../../editor/browser/editorExtensions.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { joinPath } from '../../../../base/common/resources.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { localize } from '../../../../nls.js';
import { registerAction2, Action2 } from '../../../../platform/actions/common/actions.js';
import { decodePackEnvelope, ComputedHash } from '../common/skillPackVerifier.js';
import {
	decodePersonasCatalogUrl,
	preparePersonasImport,
	renderPersonasDiffMarkdown,
	PersonaLite,
} from '../common/personasCommunityCatalog.js';

export const PERSONAS_COMMAND_IMPORT_FROM_URL = 'vibeide.personas.importFromUrl';

registerAction2(class extends Action2 {
	constructor() {
		super({
			id: PERSONAS_COMMAND_IMPORT_FROM_URL,
			title: { value: localize('vibeide.personas.importFromUrl.title', 'VibeIDE: Импортировать персоны по URL'), original: 'VibeIDE: Import personas from URL' },
			f1: true,
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const quickInput = accessor.get(IQuickInputService);
		const dialog = accessor.get(IDialogService);
		const fileService = accessor.get(IFileService);
		const workspace = accessor.get(IWorkspaceContextService);
		const notifications = accessor.get(INotificationService);

		const rawUrl = await quickInput.input({
			placeHolder: localize('vibeide.personas.importFromUrl.placeholder', 'https://... (vibe-community-personas-pack-v1)'),
			prompt: localize('vibeide.personas.importFromUrl.prompt', 'Введите HTTPS URL файла community personas pack'),
			validateInput: async v => {
				const t = v.trim();
				if (!t) { return null; }
				if (!t.startsWith('https://')) { return localize('vibeide.personas.importFromUrl.notHttps', 'Разрешены только HTTPS URL.'); }
				return null;
			},
		});
		if (!rawUrl?.trim()) { return; }

		const urlResult = decodePersonasCatalogUrl(rawUrl.trim());
		if (urlResult.kind !== 'ok') {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.personas.importFromUrl.badUrl', 'Неверный URL: {0}', urlResult.kind) });
			return;
		}

		let raw: unknown;
		try {
			const resp = await fetch(urlResult.url);
			if (!resp.ok) {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.fetchFailed', 'Не удалось загрузить pack: HTTP {0}', resp.status) });
				return;
			}
			raw = await resp.json();
		} catch (e) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.fetchError', 'Ошибка загрузки pack: {0}', (e as Error).message ?? String(e)) });
			return;
		}

		const envelopeResult = decodePackEnvelope(raw);
		if (!envelopeResult.ok) {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.envelopeInvalid', 'Неверный формат pack: {0}', envelopeResult.reason) });
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
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.hashError', 'Ошибка SHA-256 для {0}: {1}', entry.id, String(e)) });
				return;
			}
		}

		const incomingByPackId = new Map<string, PersonaLite>();
		for (const entry of envelopeResult.value.entries) {
			let parsed: unknown;
			try {
				parsed = JSON.parse(entry.content);
			} catch {
				notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.parseError', 'Ошибка парсинга персоны {0}.', entry.id) });
				return;
			}
			const p = parsed as Record<string, unknown>;
			incomingByPackId.set(entry.id, {
				id: entry.id,
				name: typeof p.name === 'string' ? p.name : entry.id,
				description: typeof p.description === 'string' ? p.description : undefined,
				mode: typeof p.mode === 'string' ? p.mode as PersonaLite['mode'] : undefined,
				systemPromptHash: typeof p.systemPromptHash === 'string' ? p.systemPromptHash : '',
			});
		}

		const result = preparePersonasImport({
			raw,
			computedHashes,
			currentPersonas: [],
			incomingPersonasByPackId: incomingByPackId,
		});

		if (result.kind === 'wrong-format') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.wrongFormat', 'Неподдерживаемый формат pack: {0}', result.actual) });
			return;
		}
		if (result.kind === 'envelope-invalid') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.envelopeInvalid2', 'Неверный формат pack: {0}', result.reason) });
			return;
		}
		if (result.kind === 'verify-failed') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.verifyFailed', 'SHA-256 верификация не пройдена: {0}', result.reason) });
			return;
		}
		if (result.kind === 'missing-incoming-persona') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.missingPersona', 'Персона {0} объявлена в манифесте, но отсутствует в entries.', result.id) });
			return;
		}
		if (result.kind === 'persona-id-malformed') {
			notifications.notify({ severity: Severity.Error, message: localize('vibeide.personas.importFromUrl.idMalformed', 'Неверный id персоны: {0}', result.id) });
			return;
		}

		const systemPromptWarning = result.diff.touchesSystemPrompt
			? `\n\n⚠️ ${localize('vibeide.personas.importFromUrl.systemPromptWarning', 'Пакет изменяет системный промпт агента. Проверьте содержимое перед подтверждением.')}`
			: '';
		const confirmed = await dialog.confirm({
			message: localize('vibeide.personas.importFromUrl.confirmTitle', 'VibeIDE: импорт персон из URL'),
			detail: renderPersonasDiffMarkdown(result.diff) + systemPromptWarning,
			primaryButton: localize('vibeide.personas.importFromUrl.confirmBtn', 'Импортировать'),
		});
		if (!confirmed.confirmed) { return; }

		const folder = workspace.getWorkspace().folders[0];
		if (!folder) {
			notifications.notify({ severity: Severity.Warning, message: localize('vibeide.personas.importFromUrl.noWorkspace', 'Откройте рабочую папку для сохранения персон.') });
			return;
		}

		let written = 0;
		for (const entry of envelopeResult.value.entries) {
			const personaDir = joinPath(folder.uri, '.vibe', 'personas', entry.id);
			const personaFile = joinPath(personaDir, 'persona.md');
			try {
				await fileService.writeFile(personaFile, VSBuffer.fromString(entry.content));
				written++;
			} catch (e) {
				notifications.notify({ severity: Severity.Warning, message: localize('vibeide.personas.importFromUrl.writeError', 'Не удалось записать персону {0}: {1}', entry.id, (e as Error).message ?? String(e)) });
			}
		}

		notifications.notify({
			severity: Severity.Info,
			message: localize('vibeide.personas.importFromUrl.success', 'Импортировано {0} персон в .vibe/personas/.', written),
		});
	}
});
