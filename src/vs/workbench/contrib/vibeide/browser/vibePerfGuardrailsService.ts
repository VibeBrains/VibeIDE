/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Performance Guardrails runtime persistence (roadmap L991 / closes L1056
 * "runtime persistence pending" note).
 *
 * Appends each `GuardrailTripEvent` to `.vibe/perf-guardrails-events.jsonl`
 * (one JSON line per event). The CJS aggregator `scripts/lib/perf-guardrails-
 * aggregator.cjs` consumed by `vibe doctor --perf` reads from the same file,
 * so the doctor wrapper now has live data once any caller invokes
 * `recordTrip()`.
 *
 * Append-only, fail-soft: a single write error never disrupts the producer's
 * critical path. The aggregator is robust to partial / malformed lines.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { Queue } from '../../../../base/common/async.js';
import { joinPath } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { VSBuffer } from '../../../../base/common/buffer.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { GuardrailRule, GuardrailTripEvent } from '../common/perfGuardrailsAggregator.js';

const EVENTS_FILE_NAME = '.vibe/perf-guardrails-events.jsonl';
/** Hard ceiling so a runaway producer can't fill the disk. */
const MAX_FILE_BYTES = 5 * 1024 * 1024;

export const IVibePerfGuardrailsService = createDecorator<IVibePerfGuardrailsService>('vibePerfGuardrailsService');

export interface IVibePerfGuardrailsService {
	readonly _serviceBrand: undefined;

	/**
	 * Record a guardrail trip event. Append-only, fail-soft — caller never sees
	 * an exception from a failing write.
	 */
	recordTrip(event: Omit<GuardrailTripEvent, 'timestamp'> & { timestamp?: number }): Promise<void>;
}

class VibePerfGuardrailsService extends Disposable implements IVibePerfGuardrailsService {
	declare readonly _serviceBrand: undefined;

	/** Serialise writes so concurrent recordTrip calls don't interleave bytes. */
	private readonly _writeQueue = new Queue<void>();

	constructor(
		@IFileService private readonly _fileService: IFileService,
		@IWorkspaceContextService private readonly _workspace: IWorkspaceContextService,
		@ILogService private readonly _log: ILogService,
	) {
		super();
		this._register({ dispose: () => this._writeQueue.dispose() });
	}

	async recordTrip(input: Omit<GuardrailTripEvent, 'timestamp'> & { timestamp?: number }): Promise<void> {
		const event: GuardrailTripEvent = {
			timestamp: input.timestamp ?? Date.now(),
			rule: input.rule,
			observedValue: input.observedValue,
			thresholdValue: input.thresholdValue,
			...(input.context !== undefined ? { context: input.context } : {}),
		};
		if (!isWellFormed(event)) {
			this._log.warn(`[VibePerfGuardrails] dropping malformed event: ${JSON.stringify(event)}`);
			return;
		}
		const uri = this._eventsUri();
		if (!uri) {
			return; // no workspace folder — nothing to persist to
		}
		await this._writeQueue.queue(() => this._appendLine(uri, event));
	}

	private _eventsUri(): URI | undefined {
		const folder = this._workspace.getWorkspace().folders[0];
		if (!folder) { return undefined; }
		return joinPath(folder.uri, ...EVENTS_FILE_NAME.split('/'));
	}

	private async _appendLine(uri: URI, event: GuardrailTripEvent): Promise<void> {
		const line = JSON.stringify(event) + '\n';
		try {
			let existing = '';
			try {
				const buf = await this._fileService.readFile(uri);
				existing = buf.value.toString();
			} catch {
				// missing file → first event, start fresh
			}
			let next = existing + line;
			if (next.length > MAX_FILE_BYTES) {
				// Drop the oldest ~25% so the file doesn't grow unbounded.
				const cutoff = next.indexOf('\n', Math.floor(next.length * 0.25));
				if (cutoff > 0) {
					next = next.slice(cutoff + 1);
				}
			}
			await this._fileService.writeFile(uri, VSBuffer.fromString(next));
		} catch (e) {
			this._log.warn(`[VibePerfGuardrails] persistence failed (${(e as Error).message}); event dropped`);
		}
	}
}

const KNOWN_RULES = new Set<GuardrailRule>(['chunk-gap', 'main-thread-block', 'memory-delta', 'fps-drop', 'startup-time']);

function isWellFormed(e: GuardrailTripEvent): boolean {
	return KNOWN_RULES.has(e.rule)
		&& Number.isFinite(e.timestamp)
		&& Number.isFinite(e.observedValue)
		&& Number.isFinite(e.thresholdValue);
}

registerSingleton(IVibePerfGuardrailsService, VibePerfGuardrailsService, InstantiationType.Delayed);
