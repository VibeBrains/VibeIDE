/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService, FileOperationError, FileOperationResult } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { URI } from '../../../../base/common/uri.js';
import { joinPath } from '../../../../base/common/resources.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';

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
		@ILogService private readonly _logService: ILogService,
	) {
		super();
		this._reloadScheduler = this._register(new RunOnceScheduler(() => this.reload(), 500));
		this._initWatcher();
		this.reload();
	}

	private async _initWatcher(): Promise<void> {
		const constraintsUri = this._getConstraintsUri();
		if (!constraintsUri) return;

		try {
			// Watch for changes to .vibe/constraints.json
			const watcher = this._fileService.watch(constraintsUri);
			this._register(watcher);
			this._register(this._fileService.onDidFilesChange(e => {
				if (e.contains(constraintsUri)) {
					this._logService.debug('[VibeIDE Constraints] File changed, scheduling reload');
					this._reloadScheduler.schedule();
				}
			}));
		} catch {
			// File may not exist yet
		}
	}

	private _getConstraintsUri(): URI | null {
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length === 0) return null;
		return joinPath(folders[0].uri, '.vibe', 'constraints.json');
	}

	async reload(): Promise<void> {
		const uri = this._getConstraintsUri();
		if (!uri) return;

		// Load constraints.json
		try {
			const content = await this._fileService.readFile(uri);
			const parsed = JSON.parse(content.value.toString()) as VibeConstraints;
			this._constraints = parsed;
			this._logService.info(`[VibeIDE Constraints] Loaded ${parsed.rules?.length ?? 0} rules from .vibe/constraints.json`);
		} catch (e) {
			if (e instanceof FileOperationError && e.fileOperationResult === FileOperationResult.FILE_NOT_FOUND) {
				this._constraints = { rules: [] };
			} else {
				this._logService.warn('[VibeIDE Constraints] Failed to parse .vibe/constraints.json:', e);
				this._constraints = { rules: [] };
			}
		}

		// Load allowed-models.json
		const folders = this._workspaceContextService.getWorkspace().folders;
		if (folders.length > 0) {
			const allowedModelsUri = joinPath(folders[0].uri, '.vibe', 'allowed-models.json');
			try {
				const content = await this._fileService.readFile(allowedModelsUri);
				const parsed = JSON.parse(content.value.toString()) as { models?: string[] };
				this._allowedModels = parsed.models ?? [];
				if (this._allowedModels.length > 0) {
					this._logService.info(`[VibeIDE Constraints] Allowed models: ${this._allowedModels.join(', ')}`);
				}
			} catch {
				this._allowedModels = []; // empty = all models allowed
			}
		}
	}

	isModelAllowed(modelId: string): boolean {
		if (this._allowedModels.length === 0) return true; // empty whitelist = all allowed
		return this._allowedModels.some(allowed =>
			allowed.toLowerCase() === modelId.toLowerCase() ||
			modelId.toLowerCase().includes(allowed.toLowerCase())
		);
	}

	checkWriteAllowed(filePath: string): void {
		const normalizedPath = filePath.replace(/\\/g, '/');

		for (const rule of (this._constraints.rules ?? [])) {
			if (rule.type === 'deny_write' && rule.pattern) {
				if (this._matchesPattern(normalizedPath, rule.pattern)) {
					throw new ConstraintViolationError(rule, filePath);
				}
			}
		}
	}

	checkReadAllowed(filePath: string): void {
		for (const rule of (this._constraints.rules ?? [])) {
			if (rule.type === 'deny_read' && rule.pattern) {
				if (this._matchesPattern(filePath, rule.pattern)) {
					throw new ConstraintViolationError(rule, filePath);
				}
			}
		}
	}

	/**
	 * Simple glob-like pattern matching.
	 * Supports: * (any chars except /), ** (any chars including /), ? (single char)
	 */
	private _matchesPattern(filePath: string, pattern: string): boolean {
		// Normalize separators
		const normalizedPath = filePath.replace(/\\/g, '/');
		const normalizedPattern = pattern.replace(/\\/g, '/');

		// Convert glob to regex
		const regexStr = normalizedPattern
			.replace(/[.+^${}()|[\]\\]/g, '\\$&') // escape special regex chars (not * ? **)
			.replace(/\*\*/g, '§DOUBLESTAR§')
			.replace(/\*/g, '[^/]*')
			.replace(/\?/g, '[^/]')
			.replace(/§DOUBLESTAR§/g, '.*');

		try {
			const regex = new RegExp(`(^|/)${regexStr}($|/)`);
			return regex.test(normalizedPath);
		} catch {
			// Invalid pattern — log and skip
			this._logService.warn(`[VibeIDE Constraints] Invalid pattern: ${pattern}`);
			return false;
		}
	}
}

registerSingleton(IVibeConstraintsService, VibeConstraintsService, InstantiationType.Eager);
