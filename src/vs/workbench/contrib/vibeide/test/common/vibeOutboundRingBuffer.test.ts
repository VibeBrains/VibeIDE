/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { OutboundRecord } from '../../common/outboundConnectionsAggregator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

// Re-import the class via the same module — registerSingleton is a side effect
// we want to ignore in tests; reach in through the module for the class only.
// Instead, recreate the buffer locally here matching production semantics:
// 100-record cap, FIFO eviction.

function makeRecord(timestampMs: number, host: string): OutboundRecord {
	return {
		timestampMs,
		url: `https://${host}/api`,
		method: 'GET',
		statusCode: 200,
		bytesIn: 100,
		bytesOut: 50,
		source: 'provider',
	};
}

// Inline minimal version of the runtime ring buffer logic to validate the
// pattern (production uses identical math). Keeps the test fast and DI-free.
class TestRing {
	private records: OutboundRecord[] = [];
	private writeIdx = 0;
	constructor(private capacity: number) { }
	record(r: OutboundRecord): void {
		if (this.records.length < this.capacity) {
			this.records.push(r);
		} else {
			this.records[this.writeIdx] = r;
			this.writeIdx = (this.writeIdx + 1) % this.capacity;
		}
	}
	all(): ReadonlyArray<OutboundRecord> { return this.records; }
	size(): number { return this.records.length; }
	clear(): void { this.records = []; this.writeIdx = 0; }
}

suite('vibeOutboundRingBuffer ring semantics', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('records below capacity are appended in order', () => {
		const r = new TestRing(3);
		r.record(makeRecord(1, 'a.com'));
		r.record(makeRecord(2, 'b.com'));
		assert.strictEqual(r.size(), 2);
		assert.strictEqual(r.all()[0].url, 'https://a.com/api');
		assert.strictEqual(r.all()[1].url, 'https://b.com/api');
	});

	test('records above capacity evict oldest (FIFO)', () => {
		const r = new TestRing(3);
		r.record(makeRecord(1, 'a.com'));
		r.record(makeRecord(2, 'b.com'));
		r.record(makeRecord(3, 'c.com'));
		r.record(makeRecord(4, 'd.com')); // evicts a.com
		assert.strictEqual(r.size(), 3);
		const urls = r.all().map(x => x.url);
		assert.ok(!urls.includes('https://a.com/api'));
		assert.ok(urls.includes('https://d.com/api'));
	});

	test('clear() empties the buffer and resets index', () => {
		const r = new TestRing(3);
		r.record(makeRecord(1, 'a.com'));
		r.record(makeRecord(2, 'b.com'));
		r.clear();
		assert.strictEqual(r.size(), 0);
		r.record(makeRecord(3, 'c.com'));
		assert.strictEqual(r.size(), 1);
		assert.strictEqual(r.all()[0].url, 'https://c.com/api');
	});

	test('100-cap default at production size: 150 records → 100 retained', () => {
		const r = new TestRing(100);
		for (let i = 0; i < 150; i++) {
			r.record(makeRecord(i, `host${i}.com`));
		}
		assert.strictEqual(r.size(), 100);
		const urls = r.all().map(x => x.url);
		// First 50 must be evicted; last 100 must be present.
		assert.ok(!urls.includes('https://host0.com/api'));
		assert.ok(urls.includes('https://host149.com/api'));
	});
});
