/*--------------------------------------------------------------------------------------
 *  Copyright 2025 Glass Devtools, Inc. All rights reserved.
 *  Licensed under the Apache License, Version 2.0. See LICENSE.txt for more information.
 *--------------------------------------------------------------------------------------*/

import { ILogService, LogLevel } from '../../../../platform/log/common/log.js';
import { Event } from '../../../../base/common/event.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { ISecretDetectionService } from './secretDetectionService.js';

/**
 * Wraps ILogService to redact secrets from all log output
 * This ensures secrets never reach logs, telemetry, or console
 */
export class RedactingLogService extends Disposable implements ILogService {
	declare readonly _serviceBrand: undefined;

	constructor(
		private readonly logService: ILogService,
		private readonly secretDetectionService: ISecretDetectionService,
	) {
		super();
	}

	get onDidChangeLogLevel(): Event<LogLevel> {
		return this.logService.onDidChangeLogLevel;
	}

	setLevel(level: LogLevel): void {
		this.logService.setLevel(level);
	}

	getLevel(): LogLevel {
		return this.logService.getLevel();
	}

	private redactMessage(message: string): string {
		const config = this.secretDetectionService.getConfig();
		if (!config.enabled) {
			return message;
		}
		const result = this.secretDetectionService.detectSecrets(message);
		return result.hasSecrets ? result.redactedText : message;
	}

	private redactArgs(args: any[]): any[] {
		const config = this.secretDetectionService.getConfig();
		if (!config.enabled) {
			return args;
		}
		return args.map(arg => {
			if (typeof arg === 'string') {
				const result = this.secretDetectionService.detectSecrets(arg);
				return result.hasSecrets ? result.redactedText : arg;
			}
			if (arg && typeof arg === 'object') {
				const result = this.secretDetectionService.redactSecretsInObject(arg);
				return result.hasSecrets ? result.redacted : arg;
			}
			return arg;
		});
	}

	trace(message: string, ...args: any[]): void {
		this.logService.trace(this.redactMessage(message), ...this.redactArgs(args));
	}

	debug(message: string, ...args: any[]): void {
		this.logService.debug(this.redactMessage(message), ...this.redactArgs(args));
	}

	info(message: string, ...args: any[]): void {
		this.logService.info(this.redactMessage(message), ...this.redactArgs(args));
	}

	warn(message: string, ...args: any[]): void {
		this.logService.warn(this.redactMessage(message), ...this.redactArgs(args));
	}

	error(message: string | Error, ...args: any[]): void {
		if (message instanceof Error) {
			// Redact error message
			const redactedMessage = this.redactMessage(message.message);
			const redactedError = new Error(redactedMessage);
			redactedError.name = message.name;
			redactedError.stack = message.stack ? this.redactMessage(message.stack) : undefined;
			this.logService.error(redactedError, ...this.redactArgs(args));
		} else {
			this.logService.error(this.redactMessage(message), ...this.redactArgs(args));
		}
	}

	flush(): void {
		this.logService.flush();
	}
}

