/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { vibeLog } from '../common/vibeLog.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import { Emitter, Event } from '../../../../base/common/event.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';

export interface AgentWrittenRange {
	filePath: string;
	startLine: number;
	endLine: number;
	sessionId: string;
	timestamp: number;
}

export const IVibeGutterIndicatorService = createDecorator<IVibeGutterIndicatorService>('vibeGutterIndicatorService');

export interface IVibeGutterIndicatorService {
	readonly _serviceBrand: undefined;

	/** Record lines written by agent in current session */
	recordAgentWrite(filePath: string, startLine: number, endLine: number): void;

	/** Get all agent-written ranges for a file in current session */
	getAgentRanges(filePath: string): AgentWrittenRange[];

	/** Clear all ranges for current session (new session) */
	clearSession(): void;

	/** Get current session ID */
	getSessionId(): string;

	/** Fired when agent lines are recorded (decorations refresh) */
	readonly onDidRecordAgentWrite: Event<void>;
}

/**
 * VibeIDE Gutter Indicators: tracks lines written by agent in current session.
 * Used by editor decoration provider to show different color in gutter.
 * Data is per-session (cleared when new session starts).
 */
class VibeGutterIndicatorService extends Disposable implements IVibeGutterIndicatorService {
	declare readonly _serviceBrand: undefined;

	private readonly _ranges = new Map<string, AgentWrittenRange[]>();
	private readonly _onDidRecordAgentWrite = this._register(new Emitter<void>());
	readonly onDidRecordAgentWrite = this._onDidRecordAgentWrite.event;

	private _sessionId: string;

	constructor(
	) {
		super();
		this._sessionId = this._generateSessionId();
	}

	recordAgentWrite(filePath: string, startLine: number, endLine: number): void {
		const existing = this._ranges.get(filePath) ?? [];
		existing.push({
			filePath,
			startLine,
			endLine,
			sessionId: this._sessionId,
			timestamp: Date.now(),
		});
		this._ranges.set(filePath, existing);
		vibeLog.debug('Gutter', `Agent wrote lines ${startLine}-${endLine} in ${filePath}`);
		this._onDidRecordAgentWrite.fire();
	}

	getAgentRanges(filePath: string): AgentWrittenRange[] {
		return this._ranges.get(filePath) ?? [];
	}

	clearSession(): void {
		this._ranges.clear();
		this._sessionId = this._generateSessionId();
		vibeLog.debug('Gutter', 'Session cleared');
	}

	getSessionId(): string {
		return this._sessionId;
	}

	private _generateSessionId(): string {
		return `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
	}
}

registerSingleton(IVibeGutterIndicatorService, VibeGutterIndicatorService, InstantiationType.Eager);
