/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from './vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { localize } from '../../../../nls.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';

import { INotificationService, Severity } from '../../../../platform/notification/common/notification.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { parseConfigJsonOrDefaults } from './vibeConfigJsonParser.js';

export interface VibeConstraintRule {
	type: 'deny_write' | 'deny_read' | 'max_lines_per_function' | 'deny_age';
	pattern?: string;     // glob pattern for deny_write/deny_read
	value?: number;       // for max_lines_per_function
	older_than_months?: number; // for deny_age
	message?: string;     // user-facing message shown when blocked
}

export interface VibeConstraints {
	vibeVersion?: string;
	rules: VibeConstraintRule[];
}

export const IVibeConstraintsService = createDecorator<IVibeConstraintsService>('vibeConstraintsService');

export interface IVibeConstraintsService {
	readonly _serviceBrand: undefined;

	/**
	 * Check if writing to a file path is allowed.
	 * Throws ConstraintViolationError if denied.
	 * This is a DETERMINISTIC check — not a prompt instruction.
	 */
	checkWriteAllowed(filePath: string): void;

	/**
	 * Check if reading a file path is allowed.
	 */
	checkReadAllowed(filePath: string): void;

	/**
	 * Check if a model is in .vibe/allowed-models.json whitelist.
	 * Returns true if allowed (or if whitelist is empty = all models allowed).
	 */
	isModelAllowed(modelId: string): boolean;

	/** Reload constraints from disk */
	reload(): Promise<void>;
}

export class ConstraintViolationError extends Error {
	constructor(
		public readonly constraint: VibeConstraintRule,
		public readonly filePath: string,
	) {
		super(constraint.message || `VibeIDE constraint: write to "${filePath}" is denied by .vibe/constraints.json rule: ${JSON.stringify(constraint)}`);
		this.name = 'ConstraintViolationError';
	}
}

/**
 * Pure helper. Glob-like match with `*` (single segment), `**` (cross segment), `?` (single char).
 * Anchored to path-segment boundaries via `(^|/)` ... `($|/)`. Returns false on invalid pattern
 * instead of throwing.
 */
export function matchConstraintPattern(filePath: string, pattern: string): boolean {
	const normalizedPath = filePath.replace(/\\/g, '/');
	const normalizedPattern = pattern.replace(/\\/g, '/');
	const regexStr = normalizedPattern
		.replace(/[.+^${}()|[\]\\]/g, '\\$&')
		.replace(/\*\*\//g, '§DOUBLESTARSLASH§')
		.replace(/\*\*/g, '§DOUBLESTAR§')
		.replace(/\*/g, '[^/]*')
		.replace(/\?/g, '[^/]')
		.replace(/§DOUBLESTARSLASH§/g, '(?:.*/)?')
		.replace(/§DOUBLESTAR§/g, '.*');
	try {
		return new RegExp(`(^|/)${regexStr}($|/)`).test(normalizedPath);
	} catch {
		return false;
	}
}

/**
 * Pure helper. Returns the first deny rule that matches `filePath` for `kind`,
 * or null if no rule denies. Caller is responsible for throwing.
 */
export function findDenyingConstraint(
	filePath: string,
	kind: 'deny_write' | 'deny_read',
	rules: VibeConstraintRule[],
): VibeConstraintRule | null {
	const normalized = filePath.replace(/\\/g, '/');
	for (const rule of rules) {
		if (rule.type === kind && rule.pattern && matchConstraintPattern(normalized, rule.pattern)) {
			return rule;
		}
	}
	return null;
}

/**
 * Pure helper. Returns whether `modelId` is in the workspace's allowed-models list.
 * Empty list ⇒ all models allowed (the documented default). Match is case-insensitive
 * and accepts substring (so "claude-3-5" matches "claude-3-5-sonnet-20241022").
 */
export function isModelAllowedByList(modelId: string, allowedModels: string[]): boolean {
	if (!allowedModels || allowedModels.length === 0) {
		return true;
	}
	const lower = modelId.toLowerCase();
	return allowedModels.some(allowed => {
		const a = allowed.toLowerCase();
		return a === lower || lower.includes(a);
	});
}

/**
 * VibeIDE Constraints Service: deterministic enforcement of .vibe/constraints.json.
 *
 * The agent CANNOT bypass these constraints — they are enforced at the IDE level,
 * not via prompt instructions. checkWriteAllowed() is called before any file write.
 */
class VibeConstraintsService extends Disposable implements IVibeConstraintsService {
	declare readonly _serviceBrand: undefined;

	private _constraints: VibeConstraints = { rules: [] };
	private _allowedModels: string[] = []; // empty = all models allowed
	private _reloadScheduler: RunOnceScheduler;

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspaceContextService: IWorkspaceContextService,
		@INotificationService private readonly _notificationService: INotificationService,
	) {
		super();
		this._reloadScheduler = this._register(new RunOnceScheduler(() => this.reload(), 500));
		this._initWatcher();
		this.reload();
	}

	private async _initWatcher(): Promise<void> {
		const constraintsUri = this._getConstraintsUri();
		if (!constraintsUri) { return; }

		try {
			// Watch for changes to .vibe/constraints.json
			const watcher = this._fileService.watch(constraintsUri);
			this._register(watcher);
			this._register(this._fileService.onDidFilesChange(e => {
				if (e.contains(constraintsUri)) {
					vibeLog.debug('Constraints', 'File changed, scheduling reload');
					this._reloadScheduler.schedule();
				}
			}));
		} catch {
			// File may not exist yet
		}
	}

	private _getConstraintsUri(): URI | null {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) { return null; }
		return joinPath(folders[0].uri, '.vibe', 'constraints.json');
	}

	async reload(): Promise<void> {
		const uri = this._getConstraintsUri();
		if (!uri) { return; }

		// Load constraints.json
		let raw: string | undefined;
		try {
			const content = await this._fileService.readFile(uri);
			raw = content.value.toString();
		} catch (e) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				this._constraints = { rules: [] };
			} else {
				vibeLog.warn('Constraints', 'readFile failed for .vibe/constraints.json:', e);
				this._constraints = { rules: [] };
			}
			raw = undefined;
		}
		if (raw !== undefined) {
			this._constraints = parseConfigJsonOrDefaults<VibeConstraints>(
				raw,
				{ rules: [] },
				reason => this._reportCorruptConfig('.vibe/constraints.json', uri, reason),
			);
			vibeLog.info('Constraints', `Loaded ${this._constraints.rules?.length ?? 0} rules from .vibe/constraints.json`);
		}

		// Load allowed-models.json
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const allowedModelsUri = joinPath(folders[0].uri, '.vibe', 'allowed-models.json');
			let allowedRaw: string | undefined;
			try {
				const content = await this._fileService.readFile(allowedModelsUri);
				allowedRaw = content.value.toString();
			} catch {
				allowedRaw = undefined;
				this._allowedModels = [];
			}
			if (allowedRaw !== undefined) {
				const parsed = parseConfigJsonOrDefaults<{ models?: string[] }>(
					allowedRaw,
					{ models: [] },
					reason => this._reportCorruptConfig('.vibe/allowed-models.json', allowedModelsUri, reason),
				);
				this._allowedModels = parsed.models ?? [];
				if (this._allowedModels.length > 0) {
					vibeLog.info('Constraints', `Allowed models: ${this._allowedModels.join(', ')}`);
				}
			}
		}
	}

	private _reportCorruptConfig(label: string, uri: URI, reason: string): void {
		// Empty file is a normal "no rules saved yet" state — never warn for that.
		if (reason === 'empty') { return; }
		vibeLog.warn('Constraints', `${label} corrupt (${reason}) — using safe defaults`);
		this._notificationService.notify({
			severity: Severity.Warning,
			message: localize('vibeide.constraints.corruptConfig', "VibeIDE: {0} повреждён ({1}). Применены безопасные дефолты — откройте файл и исправьте JSON, иначе ограничения не действуют.", label, reason),
			source: 'VibeIDE Constraints',
			actions: {
				primary: [{
					id: 'vibeide.openCorruptConfig',
					label: localize('vibeide.constraints.openFileAction', "Открыть файл"),
					tooltip: '',
					class: undefined,
					enabled: true,
					run: async () => { await this._fileService.resolve(uri); },
				}],
			},
		});
	}

	isModelAllowed(modelId: string): boolean {
		return isModelAllowedByList(modelId, this._allowedModels);
	}

	checkWriteAllowed(filePath: string): void {
		const denying = findDenyingConstraint(filePath, 'deny_write', this._constraints.rules ?? []);
		if (denying) {
			throw new ConstraintViolationError(denying, filePath);
		}
	}

	checkReadAllowed(filePath: string): void {
		const denying = findDenyingConstraint(filePath, 'deny_read', this._constraints.rules ?? []);
		if (denying) {
			throw new ConstraintViolationError(denying, filePath);
		}
	}
}

registerSingleton(IVibeConstraintsService, VibeConstraintsService, InstantiationType.Eager);
