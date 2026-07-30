/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Collects the evidence for TURN-CHECKS and reads their configuration.
 *
 * The checks themselves are pure (`common/agentTurnChecks`); this side does the I/O they refuse to
 * do: read the files the turn changed, run the secret detector over them, resolve cited lines.
 * Nothing here calls a model — that is the whole premise of the feature.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { URI } from '../../../../base/common/uri.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { InstantiationType, registerSingleton } from '../../../../platform/instantiation/common/extensions.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';
import { IConfigurationRegistry, Extensions as ConfigurationExtensions } from '../../../../platform/configuration/common/configurationRegistry.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { localize } from '../../../../nls.js';
import { vibeLog } from '../common/vibeLog.js';
import { DEFAULT_ENABLED_CHECKS, TurnCheckId, TurnChecksMode, TurnFacts } from '../common/agentTurnChecks.js';
import { IVibeConstraintsService, findDenyingConstraint } from '../common/vibeConstraintsService.js';
import { IVibePerFilePermissionsService, canWriteWithPermissions } from '../common/vibePerFilePermissionsService.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';

const CONFIG_MODE = 'vibeide.agent.turnChecks.mode';
const CONFIG_MAX_ATTEMPTS = 'vibeide.agent.turnChecks.maxAttempts';
const CONFIG_CHECKS = 'vibeide.agent.turnChecks.checks';

const DEFAULT_MAX_ATTEMPTS = 2;
/** Reading every changed file is bounded: a huge refactor must not stall completion. */
const MAX_FILES_SCANNED = 40;
/** Only the first citations are resolved — the point is catching a habit, not auditing prose. */
const MAX_CITATIONS_RESOLVED = 20;
/** `path/to/file.ts:123` — the shape the agent uses when pointing at code. */
const CITATION_PATTERN = /([\w./\\-]+\.[a-zA-Z]{1,8}):(\d{1,6})\b/g;

Registry.as<IConfigurationRegistry>(ConfigurationExtensions.Configuration).registerConfiguration({
	id: 'vibeide',
	title: localize('vibeide.agent.turnChecks.title', "VibeIDE — проверки результата хода"),
	type: 'object',
	properties: {
		[CONFIG_MODE]: {
			type: 'string',
			enum: ['off', 'notify', 'enforce'],
			default: 'notify',
			enumDescriptions: [
				localize('vibeide.agent.turnChecks.off', "Не проверять."),
				localize('vibeide.agent.turnChecks.notify', "Проверять и сообщать в чате; ход завершается в любом случае."),
				localize('vibeide.agent.turnChecks.enforce', "Проверять и возвращать агента на исправление, пока остаются попытки."),
			],
			description: localize('vibeide.agent.turnChecks.mode', "Детерминированные проверки того, что ход реально сделал: секреты в изменённых файлах, запись в закрытые пути, инструменты вне списка, перерасход, ссылки на несуществующие строки. Модель для этого не вызывается."),
		},
		[CONFIG_MAX_ATTEMPTS]: {
			type: 'number',
			default: DEFAULT_MAX_ATTEMPTS,
			minimum: 1,
			description: localize('vibeide.agent.turnChecks.maxAttempts', "Сколько раз в режиме «enforce» возвращать агента на исправление, прежде чем остановить прогон."),
		},
		[CONFIG_CHECKS]: {
			type: 'array',
			items: { type: 'string', enum: ['no-secret-leak', 'no-protected-path', 'forbidden-action', 'budget-exceeded', 'source-location'] },
			default: [...DEFAULT_ENABLED_CHECKS],
			description: localize('vibeide.agent.turnChecks.checks', "Какие проверки включены. По умолчанию — две, защищающие ваши данные: секреты и закрытые пути."),
		},
	},
});

export const IVibeTurnChecksService = createDecorator<IVibeTurnChecksService>('vibeTurnChecksService');

export interface ITurnCheckInput {
	/** Absolute or workspace-relative paths the turn wrote to. */
	readonly changedFiles: readonly string[];
	readonly calledTools: readonly string[];
	readonly allowedTools: readonly string[];
	/** The assistant's answer, scanned for `file:line` citations. */
	readonly answerText: string;
	readonly tokensUsed: number;
	readonly tokenQuota: number;
}

export interface IVibeTurnChecksService {
	readonly _serviceBrand: undefined;
	getMode(): TurnChecksMode;
	getMaxAttempts(): number;
	getEnabledChecks(): readonly TurnCheckId[];
	/** Gather the evidence the pure checks need. Never throws — a broken probe reports nothing. */
	collect(input: ITurnCheckInput): Promise<TurnFacts>;
}

class VibeTurnChecksService extends Disposable implements IVibeTurnChecksService {
	declare readonly _serviceBrand: undefined;

	constructor(
		@IConfigurationService private readonly _configuration: IConfigurationService,
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@IVibeConstraintsService private readonly _constraints: IVibeConstraintsService,
		@IVibePerFilePermissionsService private readonly _permissions: IVibePerFilePermissionsService,
		@ISecretDetectionService private readonly _secrets: ISecretDetectionService,
	) {
		super();
	}

	getMode(): TurnChecksMode {
		const raw = this._configuration.getValue<string>(CONFIG_MODE);
		return raw === 'off' || raw === 'enforce' ? raw : 'notify';
	}

	getMaxAttempts(): number {
		const raw = this._configuration.getValue<number>(CONFIG_MAX_ATTEMPTS);
		return typeof raw === 'number' && Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : DEFAULT_MAX_ATTEMPTS;
	}

	getEnabledChecks(): readonly TurnCheckId[] {
		const raw = this._configuration.getValue<string[]>(CONFIG_CHECKS);
		if (!Array.isArray(raw)) {
			return DEFAULT_ENABLED_CHECKS;
		}
		const known = new Set<string>(['no-secret-leak', 'no-protected-path', 'forbidden-action', 'budget-exceeded', 'source-location']);
		return raw.filter((id): id is TurnCheckId => known.has(id));
	}

	async collect(input: ITurnCheckInput): Promise<TurnFacts> {
		const files = input.changedFiles.slice(0, MAX_FILES_SCANNED);
		const allowed = new Set(input.allowedTools);

		return {
			changedFiles: input.changedFiles,
			secretHits: await this._findSecrets(files),
			protectedHits: this._findProtectedWrites(files),
			forbiddenTools: input.allowedTools.length === 0
				// An empty whitelist means "not constrained here", not "everything is forbidden" —
				// reporting every call would drown the real signal.
				? []
				: [...new Set(input.calledTools.filter(tool => !allowed.has(tool)))],
			tokensUsed: input.tokensUsed,
			tokenQuota: input.tokenQuota,
			citations: await this._resolveCitations(input.answerText),
		};
	}

	// ── Private ─────────────────────────────────────────────────────────────

	private async _findSecrets(files: readonly string[]): Promise<{ file: string; kind: string }[]> {
		const hits: { file: string; kind: string }[] = [];
		for (const file of files) {
			const uri = this._toUri(file);
			if (!uri) {
				continue;
			}
			try {
				const content = (await this._fileService.readFile(uri)).value.toString();
				const result = this._secrets.detectSecrets(content);
				for (const match of result.matches) {
					hits.push({ file, kind: match.pattern.name });
				}
			} catch {
				// Unreadable (deleted, binary, permissions) — nothing to report for this file.
			}
		}
		return hits;
	}

	private _findProtectedWrites(files: readonly string[]): { file: string; pattern: string }[] {
		const rules = this._constraints.getRules();
		const permissions = this._permissions.getPermissions();
		const hits: { file: string; pattern: string }[] = [];

		for (const file of files) {
			const denying = findDenyingConstraint(file, 'deny_write', [...rules]);
			if (denying?.pattern) {
				hits.push({ file, pattern: denying.pattern });
				continue;
			}
			if (!canWriteWithPermissions(file, permissions)) {
				hits.push({ file, pattern: 'permissions.json' });
			}
		}
		return hits;
	}

	private async _resolveCitations(answerText: string): Promise<{ path: string; line: number; exists: boolean }[]> {
		const seen = new Set<string>();
		const citations: { path: string; line: number; exists: boolean }[] = [];

		for (const match of answerText.matchAll(CITATION_PATTERN)) {
			if (citations.length >= MAX_CITATIONS_RESOLVED) {
				break;
			}
			const path = match[1];
			const line = Number(match[2]);
			const key = `${path}:${line}`;
			if (seen.has(key)) {
				continue;
			}
			seen.add(key);
			citations.push({ path, line, exists: await this._lineExists(path, line) });
		}
		return citations;
	}

	private async _lineExists(path: string, line: number): Promise<boolean> {
		const uri = this._toUri(path);
		if (!uri) {
			// A path we cannot resolve is not evidence of a wrong citation — stay silent.
			return true;
		}
		try {
			const content = (await this._fileService.readFile(uri)).value.toString();
			return content.split('\n').length >= line;
		} catch {
			// The reference may point outside the workspace or at a generated file; do not accuse.
			return true;
		}
	}

	private _toUri(path: string): URI | undefined {
		try {
			if (path.startsWith('/') || /^[a-zA-Z]:[\\/]/.test(path)) {
				return URI.file(path);
			}
			const folders = this._workspace.getWorkspace().folders;
			if (folders.length === 0) {
				return undefined;
			}
			return URI.joinPath(folders[0].uri, path);
		} catch (error) {
			vibeLog.warn('turnChecks', `не удалось разобрать путь «${path}»`, error);
			return undefined;
		}
	}
}

registerSingleton(IVibeTurnChecksService, VibeTurnChecksService, InstantiationType.Delayed);
