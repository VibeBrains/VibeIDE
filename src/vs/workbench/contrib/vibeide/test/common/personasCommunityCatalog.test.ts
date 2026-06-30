/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodePersonasCatalogUrl,
	preparePersonasImport,
	diffPersonasForImport,
	renderPersonasDiffMarkdown,
	PersonaLite,
} from '../../common/personasCommunityCatalog.js';

const sha = (c: string) => c.repeat(64);

function envelope(overrides: Record<string, unknown> = {}): unknown {
	return {
		formatVersion: 'vibe-community-personas-pack-v1',
		publishedAt: 1_750_000_000_000,
		entries: [{ id: 'coder', name: 'Coder', content: 'irrelevant' }],
		manifestSha256: { coder: sha('1') },
		...overrides,
	};
}

function persona(overrides: Partial<PersonaLite> = {}): PersonaLite {
	return {
		id: 'coder',
		name: 'Coder',
		systemPromptHash: sha('p'),
		...overrides,
	};
}

suite('Personas marketplace — catalog URL + import orchestrator', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodePersonasCatalogUrl', () => {
		test('valid HTTPS → ok', () => {
			const r = decodePersonasCatalogUrl('https://catalog.vibeide.io/personas.json');
			assert.strictEqual(r.kind, 'ok');
		});

		test('http → invalid:not-https', () => {
			const r = decodePersonasCatalogUrl('http://catalog.vibeide.io/');
			assert.strictEqual(r.kind, 'invalid');
			if (r.kind === 'invalid') { assert.strictEqual(r.reason, 'not-https'); }
		});

		test('null / undefined / empty → unset', () => {
			assert.strictEqual(decodePersonasCatalogUrl(null).kind, 'unset');
			assert.strictEqual(decodePersonasCatalogUrl('').kind, 'unset');
			assert.strictEqual(decodePersonasCatalogUrl('  ').kind, 'unset');
		});

		test('non-string → invalid:not-string', () => {
			const r = decodePersonasCatalogUrl(42);
			assert.strictEqual(r.kind, 'invalid');
		});
	});

	suite('preparePersonasImport', () => {
		test('happy path — added persona', () => {
			const incoming = new Map<string, PersonaLite>([['coder', persona()]]);
			const r = preparePersonasImport({
				raw: envelope(),
				computedHashes: [{ id: 'coder', sha256: sha('1') }],
				currentPersonas: [],
				incomingPersonasByPackId: incoming,
			});
			assert.strictEqual(r.kind, 'ready');
			if (r.kind === 'ready') {
				assert.strictEqual(r.diff.stats.added, 1);
				assert.strictEqual(r.diff.touchesSystemPrompt, true);
			}
		});

		test('skill catalog passed → wrong-format', () => {
			const r = preparePersonasImport({
				raw: envelope({
					formatVersion: 'vibe-community-skills-catalog-v1',
					manifestSha256: { coder: sha('1') },
				}),
				computedHashes: [{ id: 'coder', sha256: sha('1') }],
				currentPersonas: [],
				incomingPersonasByPackId: new Map([['coder', persona()]]),
			});
			assert.strictEqual(r.kind, 'wrong-format');
		});

		test('SHA mismatch → verify-failed', () => {
			const r = preparePersonasImport({
				raw: envelope(),
				computedHashes: [{ id: 'coder', sha256: sha('2') }],
				currentPersonas: [],
				incomingPersonasByPackId: new Map([['coder', persona()]]),
			});
			assert.strictEqual(r.kind, 'verify-failed');
		});

		test('persona id pattern enforced', () => {
			const r = preparePersonasImport({
				raw: envelope({
					entries: [{ id: 'BadId', name: 'X', content: 'y' }],
					manifestSha256: { BadId: sha('1') },
				}),
				computedHashes: [{ id: 'BadId', sha256: sha('1') }],
				currentPersonas: [],
				incomingPersonasByPackId: new Map([['BadId', persona({ id: 'BadId' })]]),
			});
			// envelope decoder rejects BadId via its own ID_PATTERN first
			assert.notStrictEqual(r.kind, 'ready');
		});

		test('missing incoming persona → missing-incoming-persona', () => {
			const r = preparePersonasImport({
				raw: envelope(),
				computedHashes: [{ id: 'coder', sha256: sha('1') }],
				currentPersonas: [],
				incomingPersonasByPackId: new Map(),
			});
			assert.strictEqual(r.kind, 'missing-incoming-persona');
		});

		test('envelope decode failure', () => {
			const r = preparePersonasImport({
				raw: 'not-json-shape',
				computedHashes: [],
				currentPersonas: [],
				incomingPersonasByPackId: new Map(),
			});
			assert.strictEqual(r.kind, 'envelope-invalid');
		});
	});

	suite('diffPersonasForImport', () => {
		test('added persona', () => {
			const r = diffPersonasForImport([], [persona()]);
			assert.strictEqual(r.stats.added, 1);
			assert.strictEqual(r.touchesSystemPrompt, true);
		});

		test('modified persona — different system prompt hash', () => {
			const r = diffPersonasForImport(
				[persona()],
				[persona({ systemPromptHash: sha('q') })],
			);
			assert.strictEqual(r.stats.modified, 1);
			assert.strictEqual(r.touchesSystemPrompt, true);
		});

		test('modified persona — different name only (no prompt change)', () => {
			const r = diffPersonasForImport(
				[persona({ name: 'Coder A' })],
				[persona({ name: 'Coder B' })],
			);
			assert.strictEqual(r.stats.modified, 1);
			assert.strictEqual(r.touchesSystemPrompt, false);
		});

		test('unchanged when all fields equal', () => {
			const r = diffPersonasForImport([persona()], [persona()]);
			assert.strictEqual(r.stats.unchanged, 1);
			assert.strictEqual(r.touchesSystemPrompt, false);
		});

		test('mode change counted as modified', () => {
			const r = diffPersonasForImport(
				[persona({ mode: 'agent' })],
				[persona({ mode: 'plan' })],
			);
			assert.strictEqual(r.stats.modified, 1);
		});

		test('duplicate id in incoming dedupes (first wins)', () => {
			const r = diffPersonasForImport([], [persona(), persona({ name: 'dup' })]);
			assert.strictEqual(r.stats.added, 1);
		});
	});

	suite('renderPersonasDiffMarkdown', () => {
		test('renders summary line', () => {
			const diff = diffPersonasForImport([], [persona()]);
			const md = renderPersonasDiffMarkdown(diff);
			assert.ok(md.includes('1 добавлено'));
		});

		test('renders system-prompt warning when relevant', () => {
			const diff = diffPersonasForImport([], [persona()]);
			const md = renderPersonasDiffMarkdown(diff);
			assert.ok(md.includes('system prompt'));
		});

		test('omits warning when no system prompt change', () => {
			const diff = diffPersonasForImport(
				[persona({ name: 'A' })],
				[persona({ name: 'B' })],
			);
			const md = renderPersonasDiffMarkdown(diff);
			assert.ok(!md.includes('system prompt'));
		});

		test('truncates large change lists with «…и ещё N»', () => {
			const personas: PersonaLite[] = [];
			for (let i = 0; i < 25; i++) {
				personas.push(persona({ id: `p${i}`, name: `P${i}` }));
			}
			const diff = diffPersonasForImport([], personas);
			const md = renderPersonasDiffMarkdown(diff);
			assert.ok(md.includes('…и ещё 5'));
		});
	});
});
