/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	redactOutboundUrl,
	redactOutboundRecord,
	aggregateOutboundConnections,
	renderOutboundConnectionsMarkdown,
	OutboundRecord,
} from '../../common/outboundConnectionsAggregator.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const NOW = 1_700_000_000_000;

const rec = (overrides: Partial<OutboundRecord> = {}): OutboundRecord => ({
	timestampMs: NOW,
	url: 'https://api.example.com/v1/foo',
	method: 'GET',
	source: 'provider',
	...overrides,
});

suite('outboundConnectionsAggregator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('redactOutboundUrl', () => {
		test('strips userinfo', () => {
			const r = redactOutboundUrl('https://user:pass@host.com/x');
			assert.ok(r);
			assert.strictEqual(r!.wasRedacted, true);
			assert.ok(!r!.redactedUrl.includes('user:pass'));
			assert.strictEqual(r!.host, 'host.com');
		});

		test('replaces sensitive query params with [REDACTED]', () => {
			const r = redactOutboundUrl('https://api.example.com/v1?token=abc&apikey=xyz&x=1');
			assert.ok(r);
			assert.match(r!.redactedUrl, /token=%5BREDACTED%5D/);
			assert.match(r!.redactedUrl, /apikey=%5BREDACTED%5D/);
			assert.match(r!.redactedUrl, /x=1/);
			assert.strictEqual(r!.wasRedacted, true);
		});

		test('case-insensitive sensitive key match', () => {
			const r = redactOutboundUrl('https://api.example.com/v1?Token=abc&AUTHORIZATION=zzz');
			assert.match(r!.redactedUrl, /Token=%5BREDACTED%5D/);
			assert.match(r!.redactedUrl, /AUTHORIZATION=%5BREDACTED%5D/);
		});

		test('clean URL → wasRedacted false', () => {
			const r = redactOutboundUrl('https://api.example.com/v1/foo?q=hello');
			assert.strictEqual(r!.wasRedacted, false);
		});

		test('malformed URL → null', () => {
			assert.strictEqual(redactOutboundUrl('not a url'), null);
			assert.strictEqual(redactOutboundUrl(''), null);
		});
	});

	suite('redactOutboundRecord', () => {
		test('produces a typed redacted record', () => {
			const r = redactOutboundRecord(rec({ url: 'https://api.example.com/x?token=secret' }));
			assert.ok(r);
			assert.strictEqual(r!.host, 'api.example.com');
			assert.strictEqual(r!.redacted, true);
		});

		test('returns null on bad URL → caller drops record', () => {
			const r = redactOutboundRecord(rec({ url: 'not a url' }));
			assert.strictEqual(r, null);
		});
	});

	suite('aggregateOutboundConnections', () => {
		test('drops records older than window', () => {
			const r = aggregateOutboundConnections([
				rec({ timestampMs: NOW - 10 * 60_000 }), // 10m old, default window 5m
				rec({ timestampMs: NOW - 1 * 60_000 }),  //  1m old
			], { now: NOW });
			assert.strictEqual(r.totalRecords, 1);
		});

		test('drops records with malformed URL', () => {
			const r = aggregateOutboundConnections([
				rec({ url: 'not a url' }),
				rec({ url: 'https://ok.example.com/x' }),
			], { now: NOW });
			assert.strictEqual(r.totalRecords, 1);
		});

		test('groups by (host, source)', () => {
			const r = aggregateOutboundConnections([
				rec({ url: 'https://h1.com/a', source: 'provider' }),
				rec({ url: 'https://h1.com/b', source: 'provider' }),
				rec({ url: 'https://h1.com/c', source: 'mcp' }),       // same host, different source → diff group
				rec({ url: 'https://h2.com/a', source: 'provider' }),
			], { now: NOW });
			assert.strictEqual(r.groups.length, 3);
		});

		test('group count + bytes accumulate', () => {
			const r = aggregateOutboundConnections([
				rec({ bytesIn: 100, bytesOut: 50 }),
				rec({ bytesIn: 200, bytesOut: 25 }),
			], { now: NOW });
			assert.strictEqual(r.groups[0].count, 2);
			assert.strictEqual(r.groups[0].totalBytesIn, 300);
			assert.strictEqual(r.groups[0].totalBytesOut, 75);
		});

		test('status code histogram', () => {
			const r = aggregateOutboundConnections([
				rec({ statusCode: 200 }),
				rec({ statusCode: 200 }),
				rec({ statusCode: 404 }),
			], { now: NOW });
			assert.strictEqual(r.groups[0].statusCodeHistogram[200], 2);
			assert.strictEqual(r.groups[0].statusCodeHistogram[404], 1);
		});

		test('perSource counts every source', () => {
			const r = aggregateOutboundConnections([
				rec({ source: 'provider' }),
				rec({ source: 'mcp' }),
				rec({ source: 'mcp' }),
				rec({ source: 'update' }),
			], { now: NOW });
			assert.strictEqual(r.perSource.provider, 1);
			assert.strictEqual(r.perSource.mcp, 2);
			assert.strictEqual(r.perSource.update, 1);
			assert.strictEqual(r.perSource.telemetry, 0);
		});

		test('groups sorted by count desc, host asc tie-break', () => {
			const r = aggregateOutboundConnections([
				rec({ url: 'https://b.com/x' }),
				rec({ url: 'https://a.com/x' }),
				rec({ url: 'https://a.com/y' }),
			], { now: NOW });
			assert.strictEqual(r.groups[0].host, 'a.com');  // count=2 wins
			assert.strictEqual(r.groups[1].host, 'b.com');  // count=1
		});

		test('contexts deduplicated and sorted', () => {
			const r = aggregateOutboundConnections([
				rec({ context: 'openai' }),
				rec({ context: 'anthropic' }),
				rec({ context: 'openai' }),
			], { now: NOW });
			assert.deepStrictEqual(r.groups[0].contexts, ['anthropic', 'openai']);
		});

		test('first/last timestamps tracked per group', () => {
			const r = aggregateOutboundConnections([
				rec({ timestampMs: NOW - 30_000 }),
				rec({ timestampMs: NOW - 10_000 }),
				rec({ timestampMs: NOW - 20_000 }),
			], { now: NOW });
			assert.strictEqual(r.groups[0].firstAtMs, NOW - 30_000);
			assert.strictEqual(r.groups[0].lastAtMs, NOW - 10_000);
		});

		test('custom window honored', () => {
			const r = aggregateOutboundConnections([
				rec({ timestampMs: NOW - 30 * 60_000 }),
			], { now: NOW, windowMs: 60 * 60_000 });
			assert.strictEqual(r.totalRecords, 1);
		});

		test('empty input → empty groups + zero perSource', () => {
			const r = aggregateOutboundConnections([], { now: NOW });
			assert.strictEqual(r.totalRecords, 0);
			assert.strictEqual(r.groups.length, 0);
		});

		test('redacted URL flows into rendered group host', () => {
			const r = aggregateOutboundConnections([
				rec({ url: 'https://user:pw@h.com/path?token=secret' }),
			], { now: NOW });
			assert.strictEqual(r.groups[0].host, 'h.com');
		});
	});

	suite('renderOutboundConnectionsMarkdown', () => {
		test('empty aggregate renders placeholder', () => {
			const r = aggregateOutboundConnections([], { now: NOW });
			const md = renderOutboundConnectionsMarkdown(r);
			assert.match(md, /no outbound connections/i);
		});

		test('table includes host + source + count', () => {
			const r = aggregateOutboundConnections([
				rec({ url: 'https://h.com/x', source: 'provider' }),
			], { now: NOW });
			const md = renderOutboundConnectionsMarkdown(r);
			assert.match(md, /\| h\.com \|/);
			assert.match(md, /\| provider \|/);
		});

		test('per-source line shown when any source has count > 0', () => {
			const r = aggregateOutboundConnections([
				rec({ source: 'provider' }),
				rec({ source: 'mcp' }),
			], { now: NOW });
			const md = renderOutboundConnectionsMarkdown(r);
			assert.match(md, /provider=1/);
			assert.match(md, /mcp=1/);
		});

		test('window formatted in s/m/h', () => {
			const r = aggregateOutboundConnections([], { now: NOW, windowMs: 5 * 60_000 });
			assert.match(renderOutboundConnectionsMarkdown(r), /5m/);
		});
	});
});
