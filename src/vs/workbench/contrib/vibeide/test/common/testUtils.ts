/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Test scaffolding for VibeIDE service tests (L.0 / 984).
 *
 * Most VibeIDE tests follow the pure-helper pattern and never need DI mocks.
 * This file provides a `createMockVibeServices()` aggregator for the cases
 * where the wrapper layer must be exercised — drops the barrier to writing
 * tests for IAuditLogService consumers, IConfigurationService-dependent
 * services, and ILogService-using flows.
 *
 * Mocks are intentionally minimal: they record interesting side effects in
 * public arrays so the test can assert against them. They do NOT mimic full
 * platform behaviour — when a test needs that, instantiate the real service.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { NullLogService, type ILogService } from '../../../../../platform/log/common/log.js';
import { TestConfigurationService } from '../../../../../platform/configuration/test/common/testConfigurationService.js';
import type { IConfigurationService } from '../../../../../platform/configuration/common/configuration.js';
import type { IAuditLogService, AuditEvent } from '../../common/auditLogService.js';

/**
 * Recorder for IAuditLogService.append calls. The `events` array reflects
 * append order; `queryRecent` returns the last `limit` entries to mimic the
 * real service. `exportAll` / `deleteAll` are simple stubs.
 */
export class MockAuditLogService implements IAuditLogService {
	declare readonly _serviceBrand: undefined;

	public events: AuditEvent[] = [];
	public deleteAllCalls = 0;
	public exportAllCalls = 0;
	private _enabled = true;

	async append(event: AuditEvent): Promise<void> {
		this.events.push(event);
	}

	isEnabled(): boolean {
		return this._enabled;
	}

	setEnabled(value: boolean): void {
		this._enabled = value;
	}

	async exportAll(): Promise<string> {
		this.exportAllCalls++;
		return JSON.stringify(this.events);
	}

	async deleteAll(): Promise<void> {
		this.deleteAllCalls++;
		this.events = [];
	}

	async queryRecent(limit: number = 100): Promise<AuditEvent[]> {
		return this.events.slice(-limit);
	}
}

/**
 * In-memory ILogService recorder. Inherits NullLogService so all required
 * surface is satisfied; overrides the four levels to capture messages for
 * assertions.
 */
export class RecordingLogService extends NullLogService implements ILogService {
	public messages: Array<{ level: 'trace' | 'debug' | 'info' | 'warn' | 'error'; args: unknown[] }> = [];

	override trace(message: string, ...args: unknown[]): void {
		this.messages.push({ level: 'trace', args: [message, ...args] });
	}
	override debug(message: string, ...args: unknown[]): void {
		this.messages.push({ level: 'debug', args: [message, ...args] });
	}
	override info(message: string, ...args: unknown[]): void {
		this.messages.push({ level: 'info', args: [message, ...args] });
	}
	override warn(message: string, ...args: unknown[]): void {
		this.messages.push({ level: 'warn', args: [message, ...args] });
	}
	override error(message: string | Error, ...args: unknown[]): void {
		this.messages.push({ level: 'error', args: [message, ...args] });
	}
}

export interface MockVibeServices {
	configurationService: IConfigurationService;
	auditLogService: MockAuditLogService;
	logService: RecordingLogService;
	/** Emitter exposed so tests can fire fake config-change events. */
	configChangeEmitter: Emitter<{ readonly affectedKeys: ReadonlySet<string> }>;
	/** Convenience: assert how many times audit append was called. */
	dispose(): void;
}

export interface MockVibeServicesOptions {
	configuration?: Record<string, unknown>;
}

/**
 * Build a minimal DI mock bundle for VibeIDE service tests.
 *
 * Usage:
 *   const services = createMockVibeServices({ configuration: { 'vibeide.foo': true } });
 *   const svc = new MyService(services.configurationService, services.auditLogService, services.logService);
 *   await svc.doStuff();
 *   assert.strictEqual(services.auditLogService.events.length, 1);
 *
 * The bundle is disposable; call `dispose()` in `teardown()` to release the
 * config-change emitter.
 */
export function createMockVibeServices(options: MockVibeServicesOptions = {}): MockVibeServices {
	const configurationService = new TestConfigurationService(options.configuration ?? {});
	const auditLogService = new MockAuditLogService();
	const logService = new RecordingLogService();
	const configChangeEmitter = new Emitter<{ readonly affectedKeys: ReadonlySet<string> }>();

	return {
		configurationService,
		auditLogService,
		logService,
		configChangeEmitter,
		dispose: () => {
			configChangeEmitter.dispose();
		},
	};
}

/** Re-export for tests that want an Event<T> placeholder without spawning an emitter. */
export const NEVER: Event<unknown> = Event.None;
