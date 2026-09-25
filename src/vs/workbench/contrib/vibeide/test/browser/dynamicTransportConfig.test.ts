/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { dynamicTransportConfigOf } from '../../browser/vibeDynamicProvidersService.js';
import type { VibeideStaticModelInfo } from '../../common/modelCapabilities.js';

/**
 * What the send path gets for a provider from the files
 *
 * At send time this config replaces the provider's settings seed under the same id, so whatever electron-main needs
 * must be here: the file's model caps sat on the seed and never reached the request
 */
suite('dynamic provider transport config', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const caps: { [modelId: string]: Partial<VibeideStaticModelInfo> } = { 'm1': { contextWindow: 32_000 } };

	test('carries the model caps, the dialect, auth, query and timeout; a keyless server carries no key at all', () => {
		assert.deepStrictEqual([
			dynamicTransportConfigOf({ id: 'router', baseURL: 'https://r.example/v1', apiKeyEnv: 'R_KEY', reasoningDialect: 'openrouter' }, 'sk-1', caps),
			dynamicTransportConfigOf({ id: 'local', baseURL: 'http://localhost:8000/v1', auth: 'none', apiKeyEnv: 'IGNORED' }, 'sk-2', {}),
			dynamicTransportConfigOf({ id: 'typo', baseURL: 'https://t.example/v1', reasoningDialect: 'OpenRouter' as never }, undefined, {}),
			dynamicTransportConfigOf({ id: 'gw', baseURL: 'https://gw.example/v1', auth: { type: 'query', name: 'code' }, query: { 'api-version': 'x' }, timeoutMs: 90_000 }, 'sk-3', {}),
		], [
			{ baseURL: 'https://r.example/v1', apiKey: 'sk-1', apiKeyEnv: 'R_KEY', reasoningDialect: 'openrouter', modelCapOverrides: caps },
			{ baseURL: 'http://localhost:8000/v1', keyless: true, auth: 'none' },
			{ baseURL: 'https://t.example/v1' },
			{ baseURL: 'https://gw.example/v1', apiKey: 'sk-3', auth: { type: 'query', name: 'code' }, query: { 'api-version': 'x' }, timeoutMs: 90_000 },
		]);
	});
});
