/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeSamplingRequest,
	decodeSamplingResponse,
	decideSamplingConsent,
	SamplingRequest,
} from '../../common/mcpSamplingEnvelope.js';

const MIN_REQ = {
	messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
};

suite('MCP sampling envelope — pure decoder + consent decision', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeSamplingRequest', () => {
		test('minimal happy path', () => {
			const r = decodeSamplingRequest(MIN_REQ);
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.messages.length, 1); }
		});

		test('full request with all optional fields', () => {
			const r = decodeSamplingRequest({
				messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
				modelPreferences: { hints: [{ name: 'claude-3' }], costPriority: 0.5 },
				systemPrompt: 'You are helpful',
				includeContext: 'thisServer',
				temperature: 0.7,
				maxTokens: 1000,
				stopSequences: ['\\n\\n'],
				metadata: { sessionId: 'x' },
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.systemPrompt, 'You are helpful');
				assert.strictEqual(r.value.temperature, 0.7);
				assert.strictEqual(r.value.maxTokens, 1000);
				assert.deepStrictEqual(r.value.stopSequences, ['\\n\\n']);
			}
		});

		test('rejects null / non-object root', () => {
			assert.strictEqual(decodeSamplingRequest(null).ok, false);
			assert.strictEqual(decodeSamplingRequest('x').ok, false);
		});

		test('rejects empty messages', () => {
			const r = decodeSamplingRequest({ messages: [] });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'messages-empty'); }
		});

		test('rejects message with invalid role', () => {
			const r = decodeSamplingRequest({
				messages: [{ role: 'system', content: { type: 'text', text: 'x' } }],
			});
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('role-invalid')); }
		});

		test('image content with valid mime', () => {
			const r = decodeSamplingRequest({
				messages: [{ role: 'user', content: { type: 'image', data: 'BASE64', mimeType: 'image/png' } }],
			});
			assert.strictEqual(r.ok, true);
		});

		test('rejects image with non-image mime', () => {
			const r = decodeSamplingRequest({
				messages: [{ role: 'user', content: { type: 'image', data: 'x', mimeType: 'application/pdf' } }],
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects unknown content type', () => {
			const r = decodeSamplingRequest({
				messages: [{ role: 'user', content: { type: 'audio', data: 'x' } }],
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects temperature out of [0,2]', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, temperature: 3 });
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.strictEqual(r.reason, 'temperature-out-of-range'); }
		});

		test('rejects negative temperature', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, temperature: -0.1 });
			assert.strictEqual(r.ok, false);
		});

		test('rejects non-integer maxTokens', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, maxTokens: 1.5 });
			assert.strictEqual(r.ok, false);
		});

		test('rejects maxTokens > 1M', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, maxTokens: 2_000_000 });
			assert.strictEqual(r.ok, false);
		});

		test('rejects unknown includeContext', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, includeContext: 'something' });
			assert.strictEqual(r.ok, false);
		});

		test('rejects modelPreferences priority out of [0,1]', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, modelPreferences: { costPriority: 1.5 } });
			assert.strictEqual(r.ok, false);
		});

		test('rejects systemPrompt non-string', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, systemPrompt: 42 });
			assert.strictEqual(r.ok, false);
		});

		test('rejects stopSequences with non-string', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, stopSequences: ['ok', 42] });
			assert.strictEqual(r.ok, false);
		});

		test('rejects array metadata (must be object)', () => {
			const r = decodeSamplingRequest({ ...MIN_REQ, metadata: ['x'] });
			assert.strictEqual(r.ok, false);
		});
	});

	suite('decodeSamplingResponse', () => {
		test('happy path', () => {
			const r = decodeSamplingResponse({
				model: 'claude-3-opus',
				role: 'assistant',
				content: { type: 'text', text: 'response' },
				stopReason: 'endTurn',
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.model, 'claude-3-opus');
				assert.strictEqual(r.value.stopReason, 'endTurn');
			}
		});

		test('stopReason is optional', () => {
			const r = decodeSamplingResponse({
				model: 'm',
				role: 'assistant',
				content: { type: 'text', text: 'x' },
			});
			assert.strictEqual(r.ok, true);
			if (r.ok) { assert.strictEqual(r.value.stopReason, undefined); }
		});

		test('rejects empty model', () => {
			const r = decodeSamplingResponse({
				model: '',
				role: 'assistant',
				content: { type: 'text', text: 'x' },
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed role', () => {
			const r = decodeSamplingResponse({
				model: 'm',
				role: 'system',
				content: { type: 'text', text: 'x' },
			});
			assert.strictEqual(r.ok, false);
		});
	});

	suite('decideSamplingConsent', () => {
		const trustedRequest = (overrides: Partial<SamplingRequest> = {}): SamplingRequest => ({
			messages: [{ role: 'user', content: { type: 'text', text: 'hi' } }],
			...overrides,
		});

		test('trusted server + no images + small budget → auto-allow', () => {
			const r = decideSamplingConsent({
				request: trustedRequest(),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'auto-allow');
		});

		test('image content → require-confirm wins regardless of trust', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({
					messages: [{ role: 'user', content: { type: 'image', data: 'x', mimeType: 'image/png' } }],
				}),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'require-confirm');
			if (r.kind === 'require-confirm') { assert.strictEqual(r.reason, 'image-content'); }
		});

		test('cross-server context → require-confirm', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({ includeContext: 'allServers' }),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'require-confirm');
			if (r.kind === 'require-confirm') { assert.strictEqual(r.reason, 'context-cross-server'); }
		});

		test('untrusted server → require-confirm: first-time-server', () => {
			const r = decideSamplingConsent({
				request: trustedRequest(),
				serverTrustState: 'unknown',
				perServerSamplingApproved: false,
			});
			assert.strictEqual(r.kind, 'require-confirm');
			if (r.kind === 'require-confirm') { assert.strictEqual(r.reason, 'first-time-server'); }
		});

		test('high token budget → require-confirm: high-token-budget', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({ maxTokens: 100_000 }),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'require-confirm');
			if (r.kind === 'require-confirm') { assert.strictEqual(r.reason, 'high-token-budget'); }
		});

		test('custom highTokenThreshold respected', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({ maxTokens: 100 }),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
				highTokenThreshold: 50,
			});
			assert.strictEqual(r.kind, 'require-confirm');
		});

		test('image wins over cross-server context', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({
					messages: [{ role: 'user', content: { type: 'image', data: 'x', mimeType: 'image/png' } }],
					includeContext: 'allServers',
				}),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			if (r.kind === 'require-confirm') { assert.strictEqual(r.reason, 'image-content'); }
		});

		test('auto-allow with includeContext:none → reason context-none', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({ includeContext: 'none' }),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'auto-allow');
			if (r.kind === 'auto-allow') { assert.strictEqual(r.reason, 'context-none'); }
		});

		test('auto-allow with includeContext:thisServer → reason server-trusted', () => {
			const r = decideSamplingConsent({
				request: trustedRequest({ includeContext: 'thisServer' }),
				serverTrustState: 'trusted',
				perServerSamplingApproved: true,
			});
			assert.strictEqual(r.kind, 'auto-allow');
			if (r.kind === 'auto-allow') { assert.strictEqual(r.reason, 'server-trusted'); }
		});
	});
});
