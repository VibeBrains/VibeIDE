/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	resolveOtlpUrl,
	buildOtlpHeaders,
	buildOtlpTracesBody,
	OtlpSpan,
} from '../../common/otelHttpEnvelope.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const VALID_TRACE_ID = 'a'.repeat(32);
const VALID_SPAN_ID = 'b'.repeat(16);

function span(overrides: Partial<OtlpSpan> = {}): OtlpSpan {
	return {
		traceId: VALID_TRACE_ID,
		spanId: VALID_SPAN_ID,
		name: 'agent.run',
		kind: 'INTERNAL',
		startTimeUnixNano: '1700000000000000000',
		endTimeUnixNano: '1700000001000000000',
		...overrides,
	};
}

suite('OTLP/HTTP/JSON envelope builder — pure', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('resolveOtlpUrl', () => {
		test('base endpoint + traces signal → appends /v1/traces', () => {
			const r = resolveOtlpUrl({ endpoint: 'https://otel.example.com' }, 'traces');
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.ok(r.url.endsWith('/v1/traces')); }
		});

		test('endpoint already with /v1/traces → use as-is', () => {
			const r = resolveOtlpUrl({ endpoint: 'https://otel.example.com/v1/traces' }, 'traces');
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(new URL(r.url).pathname, '/v1/traces'); }
		});

		test('per-signal paths', () => {
			const t = resolveOtlpUrl({ endpoint: 'http://localhost:4318' }, 'traces');
			const m = resolveOtlpUrl({ endpoint: 'http://localhost:4318' }, 'metrics');
			const l = resolveOtlpUrl({ endpoint: 'http://localhost:4318' }, 'logs');
			if (t.ok && m.ok && l.ok) {
				assert.ok(t.url.endsWith('/v1/traces'));
				assert.ok(m.url.endsWith('/v1/metrics'));
				assert.ok(l.url.endsWith('/v1/logs'));
			}
		});

		test('endpoint with base path → appends to base', () => {
			const r = resolveOtlpUrl({ endpoint: 'https://otel.example.com/api/' }, 'traces');
			if (r.ok) { assert.ok(r.url.includes('/api/v1/traces')); }
		});

		test('empty endpoint → reject', () => {
			const r = resolveOtlpUrl({ endpoint: '' }, 'traces');
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'endpoint-empty'); }
		});

		test('non-http scheme → reject', () => {
			const r = resolveOtlpUrl({ endpoint: 'unix:///tmp/socket' }, 'traces');
			assert.strictEqual(r.ok, false);
		});

		test('malformed URL → reject', () => {
			const r = resolveOtlpUrl({ endpoint: 'not a url' }, 'traces');
			assert.strictEqual(r.ok, false);
		});
	});

	suite('buildOtlpHeaders', () => {
		test('always Content-Type application/json', () => {
			const r = buildOtlpHeaders({ endpoint: 'http://x' });
			assert.strictEqual(r.headers['Content-Type'], 'application/json');
		});

		test('merges user headers (Bearer, tenant)', () => {
			const r = buildOtlpHeaders({
				endpoint: 'http://x',
				headers: { Authorization: 'Bearer token', 'X-Tenant': 't1' },
			});
			assert.strictEqual(r.headers['Authorization'], 'Bearer token');
			assert.strictEqual(r.headers['X-Tenant'], 't1');
		});

		test('refuses content-type override', () => {
			const r = buildOtlpHeaders({
				endpoint: 'http://x',
				headers: { 'content-type': 'application/x-protobuf' },
			});
			assert.strictEqual(r.headers['Content-Type'], 'application/json');
			assert.strictEqual(Object.hasOwn(r.headers, 'content-type'), false);
		});

		test('gzip compression adds Content-Encoding', () => {
			const r = buildOtlpHeaders({ endpoint: 'http://x', compression: 'gzip' });
			assert.strictEqual(r.headers['Content-Encoding'], 'gzip');
		});

		test('compression none does not add header', () => {
			const r = buildOtlpHeaders({ endpoint: 'http://x', compression: 'none' });
			assert.strictEqual(Object.hasOwn(r.headers, 'Content-Encoding'), false);
		});
	});

	suite('buildOtlpTracesBody', () => {
		test('happy path single span', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [{ key: 'service.name', value: 'vibeide' }] },
				spans: [span()],
				scopeName: 'vibeide.agent',
				scopeVersion: '1.0.0',
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				const parsed = JSON.parse(r.body);
				assert.strictEqual(parsed.resourceSpans.length, 1);
				assert.strictEqual(parsed.resourceSpans[0].scopeSpans[0].scope.name, 'vibeide.agent');
				assert.strictEqual(parsed.resourceSpans[0].scopeSpans[0].spans.length, 1);
				assert.strictEqual(parsed.resourceSpans[0].scopeSpans[0].spans[0].traceId, VALID_TRACE_ID);
			}
		});

		test('attribute value typing — string/int/double/bool', () => {
			const r = buildOtlpTracesBody({
				resource: {
					attributes: [
						{ key: 's', value: 'str' },
						{ key: 'i', value: 42 },
						{ key: 'd', value: 1.5 },
						{ key: 'b', value: true },
					],
				},
				spans: [],
				scopeName: 'x',
			});
			if (r.ok) {
				const attrs = JSON.parse(r.body).resourceSpans[0].resource.attributes;
				assert.deepStrictEqual(attrs[0].value, { stringValue: 'str' });
				assert.deepStrictEqual(attrs[1].value, { intValue: '42' });
				assert.deepStrictEqual(attrs[2].value, { doubleValue: 1.5 });
				assert.deepStrictEqual(attrs[3].value, { boolValue: true });
			}
		});

		test('rejects malformed traceId', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span({ traceId: 'short' })],
				scopeName: 'x',
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('traceId-malformed')); }
		});

		test('rejects malformed spanId', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span({ spanId: 'short' })],
				scopeName: 'x',
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed parentSpanId when present', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span({ parentSpanId: 'BAD' })],
				scopeName: 'x',
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects empty scope name', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [],
				scopeName: '',
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed unix nano', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span({ startTimeUnixNano: 'not-a-number' })],
				scopeName: 'x',
			});
			assert.strictEqual(r.ok, false);
		});

		test('parentSpanId omitted when not provided', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span()],
				scopeName: 'x',
			});
			if (r.ok) {
				const sp = JSON.parse(r.body).resourceSpans[0].scopeSpans[0].spans[0];
				assert.strictEqual(Object.hasOwn(sp, 'parentSpanId'), false);
			}
		});

		test('status with message included', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [span({ status: { code: 'STATUS_CODE_ERROR', message: 'boom' } })],
				scopeName: 'x',
			});
			if (r.ok) {
				const sp = JSON.parse(r.body).resourceSpans[0].scopeSpans[0].spans[0];
				assert.deepStrictEqual(sp.status, { code: 'STATUS_CODE_ERROR', message: 'boom' });
			}
		});

		test('scopeVersion omitted when not provided', () => {
			const r = buildOtlpTracesBody({
				resource: { attributes: [] },
				spans: [],
				scopeName: 'x',
			});
			if (r.ok) {
				const scope = JSON.parse(r.body).resourceSpans[0].scopeSpans[0].scope;
				assert.strictEqual(Object.hasOwn(scope, 'version'), false);
			}
		});
	});
});
