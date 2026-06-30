/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * In-memory ring buffer for outbound HTTP records (roadmap §1042).
 *
 * Privacy-first: 100-record cap, never persisted to disk, never serialised
 * across the IPC boundary except on explicit user action (palette command
 * "VibeIDE: Show outbound connections" or `vibe doctor --network`).
 *
 * Wraps the pure aggregator from common/outboundConnectionsAggregator.ts —
 * collectors push raw OutboundRecord values; readers ask for the aggregated
 * view through `getRedactedSnapshot()` which applies the redaction +
 * grouping pipeline.
 */

import { Disposable } from '../../../../base/common/lifecycle.js';
import { createDecorator } from '../../../../platform/instantiation/common/instantiation.js';
import { registerSingleton, InstantiationType } from '../../../../platform/instantiation/common/extensions.js';
import {
	OutboundRecord,
	aggregateOutboundConnections,
	OutboundAggregate,
} from './outboundConnectionsAggregator.js';

export const IVibeOutboundRingBuffer = createDecorator<IVibeOutboundRingBuffer>('vibeOutboundRingBuffer');

export interface IVibeOutboundRingBuffer {
	readonly _serviceBrand: undefined;

	/** Collector entry point — adds one record, evicts oldest when full. */
	record(entry: OutboundRecord): void;

	/** Reader — returns the aggregated, redacted, grouped view. */
	getRedactedSnapshot(windowMs?: number): OutboundAggregate;

	/** Clear the buffer (e.g. on profile reset). */
	clear(): void;

	/** Current entry count (for diagnostics). */
	size(): number;
}

const RING_CAPACITY = 100;

class VibeOutboundRingBufferService extends Disposable implements IVibeOutboundRingBuffer {
	declare readonly _serviceBrand: undefined;

	private _records: OutboundRecord[] = [];
	private _writeIndex = 0;

	record(entry: OutboundRecord): void {
		if (this._records.length < RING_CAPACITY) {
			this._records.push(entry);
		} else {
			this._records[this._writeIndex] = entry;
			this._writeIndex = (this._writeIndex + 1) % RING_CAPACITY;
		}
	}

	getRedactedSnapshot(windowMs?: number): OutboundAggregate {
		return aggregateOutboundConnections(this._records, { windowMs });
	}

	clear(): void {
		this._records = [];
		this._writeIndex = 0;
	}

	size(): number {
		return this._records.length;
	}
}

registerSingleton(IVibeOutboundRingBuffer, VibeOutboundRingBufferService, InstantiationType.Delayed);
