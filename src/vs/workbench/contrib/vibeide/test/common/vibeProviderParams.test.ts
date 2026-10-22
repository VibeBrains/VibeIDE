/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Параметры провайдера из файла (`params`): подстановка в адрес, заголовки и каталог моделей,
 * умолчания, необязательные поля, поле заголовков и то, что считается ненастроенным провайдером.
 * Плюс вход `google-adc` в разборе `auth`.
 */

import * as assert from 'assert';
import { applyProviderParams } from '../../common/vibeProviderParams.js';
import { keyPlacement, normalizeAuth, parseAuth, usesGoogleAdc, VibeProviderEntry } from '../../common/vibeProvidersFile.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

const vertex: VibeProviderEntry = {
	id: 'google-vertex',
	baseURL: 'https://{region}-aiplatform.googleapis.com/v1/projects/{project}/locations/{region}/endpoints/openapi',
	auth: 'google-adc',
	params: {
		region: { title: 'Регион', default: 'us-west2' },
		project: { title: 'Проект', placeholder: 'my-project' },
	},
};

suite('vibeProviderParams — параметры провайдера из файла', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('провайдер без params приходит тем же объектом, без полей и без недостающего', () => {
		const entry: VibeProviderEntry = { id: 'plain', baseURL: 'https://api.example.com/v1' };
		const applied = applyProviderParams(entry, { region: 'x' });
		assert.strictEqual(applied.entry, entry);
		assert.deepStrictEqual([applied.fields, applied.missing, applied.warnings], [[], [], []]);
	});

	test('значения подставляются в адрес, каждое вхождение, умолчание берётся, когда ничего не введено', () => {
		const applied = applyProviderParams(vertex, { project: 'my-proj' });
		assert.strictEqual(applied.entry.baseURL, 'https://us-west2-aiplatform.googleapis.com/v1/projects/my-proj/locations/us-west2/endpoints/openapi');
		assert.deepStrictEqual(applied.missing, []);
	});

	test('введённое значение сильнее умолчания, пробелы по краям срезаются', () => {
		const applied = applyProviderParams(vertex, { region: '  europe-west4 ', project: 'p' });
		assert.strictEqual(applied.entry.baseURL, 'https://europe-west4-aiplatform.googleapis.com/v1/projects/p/locations/europe-west4/endpoints/openapi');
	});

	test('обязательный параметр без значения и без умолчания — недостающий, провайдер ещё не настроен', () => {
		const applied = applyProviderParams(vertex, {});
		assert.deepStrictEqual(applied.missing, ['project']);
		// Адрес остаётся с невыполненной скобкой: слать по нему нельзя, и вызывающий это знает по `missing`
		assert.ok(applied.entry.baseURL!.includes('{project}'));
	});

	test('поля карточки: подпись, подсказка из умолчания, введённое значение', () => {
		const applied = applyProviderParams(vertex, { project: 'p' });
		assert.deepStrictEqual(applied.fields, [
			{ name: 'region', title: 'Регион', placeholder: 'us-west2', value: '', optional: false, kind: 'text' },
			{ name: 'project', title: 'Проект', placeholder: 'my-project', value: 'p', optional: false, kind: 'text' },
		]);
	});

	test('подстановка идёт и в строку models.fetch, и в значения заголовков и параметров запроса', () => {
		const azure: VibeProviderEntry = {
			id: 'azure-openai',
			baseURL: 'https://{resource}.openai.azure.com/openai/v1',
			headers: { 'x-resource': '{resource}' },
			query: { 'api-version': '{apiVersion}' },
			models: { fetch: 'https://{resource}.openai.azure.com/openai/deployments?api-version={apiVersion}' },
			params: { resource: {}, apiVersion: { default: '2024-10-21' } },
		};
		const applied = applyProviderParams(azure, { resource: 'my-res' });
		assert.deepStrictEqual(
			[applied.entry.baseURL, applied.entry.headers, applied.entry.query, applied.entry.models?.fetch],
			[
				'https://my-res.openai.azure.com/openai/v1',
				{ 'x-resource': 'my-res' },
				{ 'api-version': '2024-10-21' },
				'https://my-res.openai.azure.com/openai/deployments?api-version=2024-10-21',
			],
		);
	});

	test('необязательный параметр без значения: подстановка пустая, заголовок на нём не уходит', () => {
		const entry: VibeProviderEntry = {
			id: 'gw',
			baseURL: 'https://gw.example.com/v1',
			headers: { 'x-team': '{team}', 'x-static': 'fixed' },
			params: { team: { optional: true } },
		};
		const applied = applyProviderParams(entry, {});
		assert.deepStrictEqual(applied.entry.headers, { 'x-static': 'fixed' });
		assert.deepStrictEqual(applied.missing, []);
		assert.strictEqual(applyProviderParams(entry, { team: 'platform' }).entry.headers?.['x-team'], 'platform');
	});

	test('поле заголовков (as: headers) вливается в headers провайдера, файловые заголовки остаются', () => {
		const entry: VibeProviderEntry = {
			id: 'compat',
			baseURL: '{endpoint}',
			headers: { 'x-fixed': '1' },
			params: { endpoint: {}, headersJSON: { as: 'headers' } },
		};
		const applied = applyProviderParams(entry, { endpoint: 'https://my.site/v1', headersJSON: '{"X-Request-Id":"abc"}' });
		assert.strictEqual(applied.entry.baseURL, 'https://my.site/v1');
		assert.deepStrictEqual(applied.entry.headers, { 'x-fixed': '1', 'X-Request-Id': 'abc' });
		assert.deepStrictEqual(applied.fields.map(f => [f.name, f.kind, f.optional]), [['endpoint', 'text', false], ['headersJSON', 'headers', true]]);
	});

	test('поле заголовков без значения не делает провайдера ненастроенным', () => {
		const entry: VibeProviderEntry = { id: 'compat', baseURL: '{endpoint}', params: { endpoint: {}, headersJSON: { as: 'headers' } } };
		assert.deepStrictEqual(applyProviderParams(entry, { endpoint: 'https://my.site/v1' }).missing, []);
	});

	test('нечитаемое поле заголовков называется предупреждением и пропускается, остальное работает', () => {
		const entry: VibeProviderEntry = { id: 'compat', baseURL: '{endpoint}', params: { endpoint: {}, headersJSON: { as: 'headers' } } };
		const notJson = applyProviderParams(entry, { endpoint: 'https://x/v1', headersJSON: '{oops' });
		assert.strictEqual(notJson.entry.baseURL, 'https://x/v1');
		assert.strictEqual(notJson.warnings.length, 1);
		const array = applyProviderParams(entry, { endpoint: 'https://x/v1', headersJSON: '["a"]' });
		assert.strictEqual(array.warnings.length, 1);
		const number = applyProviderParams(entry, { endpoint: 'https://x/v1', headersJSON: '{"a": 1, "b": "ok"}' });
		assert.deepStrictEqual(number.entry.headers, { b: 'ok' });
		assert.strictEqual(number.warnings.length, 1);
	});

	test('чужие фигурные скобки и необъявленные имена остаются как есть', () => {
		const entry: VibeProviderEntry = {
			id: 'gw',
			baseURL: 'https://gw.example.com/{tenant}/v1',
			headers: { 'x-body': '{"a": {"b": 1}}' },
			params: { region: { default: 'eu' } },
		};
		const applied = applyProviderParams(entry, {});
		assert.strictEqual(applied.entry.baseURL, 'https://gw.example.com/{tenant}/v1');
		assert.strictEqual(applied.entry.headers?.['x-body'], '{"a": {"b": 1}}');
	});

	test('кривое имя параметра и кривое описание пропускаются с предупреждением', () => {
		const entry = { id: 'x', baseURL: 'https://x/v1', params: { 'bad name': {}, ok: 'oops', fine: { default: 'v' } } } as unknown as VibeProviderEntry;
		const applied = applyProviderParams(entry, {});
		assert.deepStrictEqual(applied.fields.map(f => f.name), ['fine']);
		assert.strictEqual(applied.warnings.length, 2);
	});

	test('params не объектом — предупреждение, провайдер как есть', () => {
		const entry = { id: 'x', baseURL: 'https://x/v1', params: ['region'] } as unknown as VibeProviderEntry;
		const applied = applyProviderParams(entry, {});
		assert.strictEqual(applied.entry, entry);
		assert.strictEqual(applied.warnings.length, 1);
	});

	test('исходный провайдер не меняется', () => {
		const before = JSON.stringify(vertex);
		applyProviderParams(vertex, { project: 'p' });
		assert.strictEqual(JSON.stringify(vertex), before);
	});
});

suite('auth: "google-adc" — токен Google вместо введённого ключа', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('строка и объект читаются одинаково, регистр значения важен', () => {
		assert.deepStrictEqual(parseAuth('google-adc'), { type: 'google-adc' });
		assert.deepStrictEqual(parseAuth({ type: 'google-adc' }), { type: 'google-adc' });
		assert.strictEqual(parseAuth('Google-ADC'), 'invalid');
	});

	test('usesGoogleAdc отличает такого провайдера от остальных', () => {
		assert.strictEqual(usesGoogleAdc({ auth: 'google-adc' }), true);
		assert.strictEqual(usesGoogleAdc({ auth: { type: 'google-adc' } }), true);
		assert.strictEqual(usesGoogleAdc({ auth: 'bearer' }), false);
		assert.strictEqual(usesGoogleAdc({}), false);
		assert.deepStrictEqual(normalizeAuth('google-adc'), { type: 'google-adc' });
	});

	test('токен уходит заголовком Authorization: Bearer на любом протоколе', () => {
		assert.deepStrictEqual(keyPlacement('google-adc', 'ya29.token', 'openai'), { headers: { Authorization: 'Bearer ya29.token' }, query: {} });
		assert.deepStrictEqual(keyPlacement({ type: 'google-adc' }, 'ya29.token', 'gemini'), { headers: { Authorization: 'Bearer ya29.token' }, query: {} });
		assert.deepStrictEqual(keyPlacement('google-adc', undefined, 'openai'), { headers: {}, query: {} });
	});
});
