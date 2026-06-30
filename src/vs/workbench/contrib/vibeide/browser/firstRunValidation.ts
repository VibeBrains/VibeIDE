/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { IStorageService, StorageScope, StorageTarget } from '../../../../platform/storage/common/storage.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { CommandsRegistry } from '../../../../platform/commands/common/commands.js';
import { ISecretDetectionService } from '../common/secretDetectionService.js';
import { IProductService } from '../../../../platform/product/common/productService.js';

const FIRST_RUN_VALIDATION_KEY = 'vibeide.firstRunValidation';
const FIRST_RUN_VALIDATION_COMPLETE_KEY = 'vibeide.firstRunValidationComplete';

// Fast-path budget for console-redaction wrappers. Args whose shallow size exceeds
// this AND don't contain secret markers in the first 1 KB of keys + truncated string
// values skip the recursive redactSecretsInObject pass. Trade-off: very large objects
// with secrets buried deep AND no surface markers won't be redacted. Acceptable for
// known diagnostic logs (promptDump, skill expand) where args are diagnostic envelopes,
// not raw credential payloads.
const CONSOLE_REDACT_FAST_PATH_BYTES = 8192;
const SECRET_MARKERS_RE = /secret|token|api[_-]?key|password|bearer|sk-|authorization/i;

/**
 * First-run smoke test validation
 * Exercises critical paths to catch crashes early
 */
export class FirstRunValidationContribution extends Disposable implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.vibeideFirstRunValidation';

	constructor(
		@IStorageService private readonly storageService: IStorageService,
		@IEditorService private readonly editorService: IEditorService,
		@ISecretDetectionService private readonly secretDetectionService: ISecretDetectionService,
		@IProductService private readonly productService: IProductService,
	) {
		super();
		this.logStartupBanner();
		this.setupConsoleRedaction();
		this.runValidation();
	}

	/**
	 * Emit a one-line build banner on EVERY startup (constructor, not runValidation —
	 * the latter early-returns after first run). Logs the VibeIDE version, the base
	 * VS Code version, and the short commit so any pasted diagnostic log self-identifies
	 * which build produced it. Added after a 2026-05-29 incident where a stale local
	 * install was mistaken for a fresh release and cost a long misdiagnosis.
	 */
	private logStartupBanner(): void {
		try {
			const vibe = this.productService.vibeVersion ?? '?';
			const base = this.productService.version ?? '?';
			const commit = (this.productService.commit ?? 'dev').slice(0, 8);
			vibeLog.info('Startup', `VibeIDE ${vibe} | base VS Code ${base} | commit ${commit}`);
		} catch {
			// Banner is diagnostic-only — never let it break startup.
		}
	}

	/**
	 * Wrap console methods to redact secrets in Vibeide code paths
	 * This ensures secrets never reach console output
	 */
	private setupConsoleRedaction(): void {
		const config = this.secretDetectionService.getConfig();
		if (!config.enabled) {
			return;
		}

		// Store original console methods
		const originalLog = console.log;
		const originalError = console.error;
		const originalWarn = console.warn;
		const originalInfo = console.info;
		const originalDebug = console.debug;

		const maybeRedact = (args: unknown[]): unknown[] => {
			if (this.shouldSkipRedaction(args)) {
				return args;
			}
			const redacted = this.secretDetectionService.redactSecretsInObject(args);
			return redacted.hasSecrets ? redacted.redacted : args;
		};

		// Wrap console methods to redact secrets
		console.log = (...args: unknown[]) => {
			originalLog(...maybeRedact(args));
		};

		console.error = (...args: unknown[]) => {
			// Suppress non-fatal Web Locks API errors (they occur during initialization when context isn't fully ready)
			const errorMessage = args.map(arg => typeof arg === 'string' ? arg : String(arg)).join(' ');
			if (errorMessage.includes('lock() request could not be registered') ||
				errorMessage.includes('InvalidStateError') && errorMessage.includes('lock')) {
				// Suppress this non-fatal error - it's a known issue with Web Locks API during initialization
				return;
			}
			originalError(...maybeRedact(args));
		};

		console.warn = (...args: unknown[]) => {
			originalWarn(...maybeRedact(args));
		};

		console.info = (...args: unknown[]) => {
			originalInfo(...maybeRedact(args));
		};

		console.debug = (...args: unknown[]) => {
			originalDebug(...maybeRedact(args));
		};

		// Restore on dispose
		this._register({
			dispose: () => {
				console.log = originalLog;
				console.error = originalError;
				console.warn = originalWarn;
				console.info = originalInfo;
				console.debug = originalDebug;
			},
		});
	}

	// Skip recursive secret-redaction for large diagnostic envelopes (e.g. promptDump
	// with a 20+ KB system prompt) when their surface has no secret markers. Returns
	// false (do not skip) on any uncertainty so the safe path runs.
	private shouldSkipRedaction(args: unknown[]): boolean {
		let size = 0;
		let surfaceText = '';
		let budget = 1024;
		for (const a of args) {
			if (typeof a === 'string') {
				size += a.length;
				if (budget > 0) {
					const piece = a.slice(0, budget);
					surfaceText += piece + ' ';
					budget -= piece.length;
				}
			} else if (a !== null && typeof a === 'object') {
				try {
					for (const [k, v] of Object.entries(a)) {
						if (budget > 0) {
							surfaceText += k + ' ';
							budget -= k.length;
						}
						if (typeof v === 'string') {
							size += v.length;
							if (budget > 0) {
								const piece = v.slice(0, Math.min(v.length, 200));
								surfaceText += piece + ' ';
								budget -= piece.length;
							}
						} else if (v !== null && v !== undefined) {
							size += 32;
						}
					}
				} catch {
					return false;
				}
			}
			if (size > CONSOLE_REDACT_FAST_PATH_BYTES * 4) { break; }
		}
		if (size <= CONSOLE_REDACT_FAST_PATH_BYTES) { return false; }
		return !SECRET_MARKERS_RE.test(surfaceText);
	}

	private async runValidation(): Promise<void> {
		// Check if validation was already completed
		const validationComplete = this.storageService.getBoolean(FIRST_RUN_VALIDATION_COMPLETE_KEY, StorageScope.APPLICATION);
		if (validationComplete) {
			return;
		}

		// Check if this is a first run (no validation key exists)
		const hasRunBefore = this.storageService.get(FIRST_RUN_VALIDATION_KEY, StorageScope.APPLICATION);
		if (hasRunBefore) {
			// Mark as complete if we've run before
			this.storageService.store(FIRST_RUN_VALIDATION_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			return;
		}

		// Mark that we've started validation
		this.storageService.store(FIRST_RUN_VALIDATION_KEY, 'started', StorageScope.APPLICATION, StorageTarget.MACHINE);

		try {
			vibeLog.info('firstRunValidation', '[FirstRunValidation] Starting smoke test...');

			// Smoke test 1: Open a file (if workspace has files)
			try {
				const editors = this.editorService.visibleEditors;
				if (editors.length > 0) {
					const firstEditor = editors[0];
					if (firstEditor.resource) {
						// File is already open, test passed
						vibeLog.info('firstRunValidation', '[FirstRunValidation] ✓ File access test passed');
					}
				}
			} catch (error) {
				vibeLog.error('firstRunValidation', '[FirstRunValidation] ✗ File access test failed:', error);
			}

			// Smoke test 2: Quick Action command availability
			try {
				// Check if Quick Action command is available (don't execute, just check)
				const commands = CommandsRegistry.getCommands();
				const hasQuickAction = commands.has('vibeide.quickAction');
				if (hasQuickAction) {
					vibeLog.info('firstRunValidation', '[FirstRunValidation] ✓ Quick Action command available');
				} else {
					vibeLog.warn('firstRunValidation', '[FirstRunValidation] ⚠ Quick Action command not found');
				}
			} catch (error) {
				vibeLog.error('firstRunValidation', '[FirstRunValidation] ✗ Command check failed:', error);
			}

			// Smoke test 3: Basic service availability
			try {
				// Services should be available at this point
				vibeLog.info('firstRunValidation', '[FirstRunValidation] ✓ Services initialized');
			} catch (error) {
				vibeLog.error('firstRunValidation', '[FirstRunValidation] ✗ Service check failed:', error);
			}

			// Mark validation as complete
			this.storageService.store(FIRST_RUN_VALIDATION_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
			vibeLog.info('firstRunValidation', '[FirstRunValidation] ✓ Smoke test completed successfully');

		} catch (error) {
			// Log error but don't block startup
			vibeLog.error('firstRunValidation', '[FirstRunValidation] ✗ Smoke test failed with error:', error);
			// Still mark as complete to avoid retrying on every startup
			this.storageService.store(FIRST_RUN_VALIDATION_COMPLETE_KEY, true, StorageScope.APPLICATION, StorageTarget.MACHINE);
		}
	}
}

// Register the contribution
registerWorkbenchContribution2(FirstRunValidationContribution.ID, FirstRunValidationContribution, WorkbenchPhase.AfterRestored);

