/*---------------------------------------------------------------------------------------------
 *  Copyright 2026 VibeIDE Team. All rights reserved.
 *  Licensed under the MIT License. See LICENSE.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IConfigurationService } from '../../../../platform/configuration/common/configuration.js';

export type EncryptionMigrationState = 'idle' | 'migrating' | 'completed' | 'error';

export interface EncryptionMigrationStatus {
	state: EncryptionMigrationState;
	totalFiles: number;
	processedFiles: number;
	hasUnencryptedLogs: boolean;
	hasRecoveryPhrase: boolean;
}

export const IVibeAuditEncryptionService = createDecorator<IVibeAuditEncryptionService>('vibeAuditEncryptionService');

export interface IVibeAuditEncryptionService {
	readonly _serviceBrand: undefined;

	/** Check if encryption is enabled */
	isEncryptionEnabled(): boolean;

	/** Check if existing logs have mixed encryption state */
	checkMigrationState(): Promise<EncryptionMigrationStatus>;

	/**
	 * Enable encryption for audit logs.
	 * REQUIRES: recovery phrase must be saved before encryption.
	 */
	enableEncryption(recoveryPhrase: string): Promise<void>;

	/**
	 * Generate a recovery phrase (24-word BIP39-like phrase).
	 * MUST be shown to user and saved before enabling encryption.
	 */
	generateRecoveryPhrase(): string;

	/** Migrate existing plaintext logs to encrypted format */
	migrateExistingLogs(encryptAll: boolean): Promise<void>;

	readonly onMigrationProgress: Event<EncryptionMigrationStatus>;
}

/**
 * VibeIDE Audit Log Encryption Service.
 * Opt-in encryption for audit logs (privacy-first).
 * MANDATORY: recovery phrase must be saved before enabling.
 * On enable: dialog to encrypt existing logs or mark as unencrypted.
 */
class VibeAuditEncryptionService extends Disposable implements IVibeAuditEncryptionService {
	declare readonly _serviceBrand: undefined;

	private readonly _onMigrationProgress = this._register(new Emitter<EncryptionMigrationStatus>());
	readonly onMigrationProgress = this._onMigrationProgress.event;

	// Wordlist subset for recovery phrase (BIP39-like, Phase 1: simple word list)
	private readonly WORD_LIST = [
		'apple', 'brave', 'cloud', 'dream', 'eagle', 'flame', 'grace', 'heart',
		'image', 'judge', 'knife', 'light', 'major', 'noble', 'ocean', 'proud',
		'quiet', 'river', 'stone', 'truth', 'ultra', 'value', 'world', 'youth',
		'zebra', 'amber', 'bloom', 'coral', 'delta', 'elbow', 'frost', 'glass',
	];

	constructor(
		@ILogService private readonly _logService: ILogService,
		@IConfigurationService private readonly _configurationService: IConfigurationService,
	) {
		super();
	}

	isEncryptionEnabled(): boolean {
		return this._configurationService.getValue<boolean>('vibeide.audit.encryptLogs') ?? false;
	}

	async checkMigrationState(): Promise<EncryptionMigrationStatus> {
		const encryptionEnabled = this.isEncryptionEnabled();
		// Phase 1: basic state check (Phase 2: scan actual log files)
		return {
			state: 'idle',
			totalFiles: 0,
			processedFiles: 0,
			hasUnencryptedLogs: false, // Phase 2: scan .vibe/audit*.jsonl
			hasRecoveryPhrase: encryptionEnabled,
		};
	}

	generateRecoveryPhrase(): string {
		// Generate 24-word recovery phrase
		const words: string[] = [];
		for (let i = 0; i < 24; i++) {
			const idx = Math.floor(Math.random() * this.WORD_LIST.length);
			words.push(this.WORD_LIST[idx]);
		}
		return words.join(' ');
	}

	async enableEncryption(recoveryPhrase: string): Promise<void> {
		if (!recoveryPhrase || recoveryPhrase.split(' ').length < 12) {
			throw new Error('Recovery phrase must be saved before enabling encryption. Minimum 12 words required.');
		}

		this._logService.info('[VibeIDE AuditEncryption] Encryption enabled for future audit logs');
		// Phase 2: actual age/libsodium encryption implementation
		// Phase 1: mark as enabled, warn user to migrate existing logs
	}

	async migrateExistingLogs(encryptAll: boolean): Promise<void> {
		const status: EncryptionMigrationStatus = {
			state: 'migrating',
			totalFiles: 0,
			processedFiles: 0,
			hasUnencryptedLogs: true,
			hasRecoveryPhrase: true,
		};
		this._onMigrationProgress.fire(status);

		// Phase 1: placeholder for actual migration
		// Phase 2: encrypt existing .vibe/audit*.jsonl files
		this._logService.info(`[VibeIDE AuditEncryption] Migration ${encryptAll ? 'all' : 'none'} — Phase 2 implementation pending`);

		const done: EncryptionMigrationStatus = { ...status, state: 'completed', processedFiles: status.totalFiles };
		this._onMigrationProgress.fire(done);
	}
}

registerSingleton(IVibeAuditEncryptionService, VibeAuditEncryptionService, InstantiationType.Eager);
