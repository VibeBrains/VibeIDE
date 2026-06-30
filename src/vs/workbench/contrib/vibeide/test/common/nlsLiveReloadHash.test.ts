/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	decideNlsLiveReload,
	buildNlsBundleSnapshot,
	fnv1a32,
	groupKeysByPrefix,
	NlsBundleSnapshot,
} from '../../common/nlsLiveReloadHash.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

function snap(localeTag: string, entries: Map<string, string>): NlsBundleSnapshot {
	return buildNlsBundleSnapshot(localeTag, entries, fnv1a32);
}

suite('NLS bundle live-reload hash diff', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decideNlsLiveReload', () => {
		test('no previous → no-op:no-prior', () => {
			const r = decideNlsLiveReload({
				previous: null,
				current: snap('ru', new Map([['a', 'А']])),
			});
			assert.strictEqual(r.kind, 'no-op');
			if (r.kind === 'no-op') { assert.strictEqual(r.reason, 'no-prior'); }
		});

		test('identical bundleHash → no-op:identical', () => {
			const map = new Map([['a', 'А']]);
			const a = snap('ru', map);
			const b = snap('ru', map);
			const r = decideNlsLiveReload({ previous: a, current: b });
			assert.strictEqual(r.kind, 'no-op');
			if (r.kind === 'no-op') { assert.strictEqual(r.reason, 'identical'); }
		});

		test('locale changed → full-reload:locale-changed', () => {
			const r = decideNlsLiveReload({
				previous: snap('ru', new Map([['a', 'А']])),
				current: snap('de', new Map([['a', 'A']])),
			});
			assert.strictEqual(r.kind, 'full-reload');
			if (r.kind === 'full-reload') { assert.strictEqual(r.reason, 'locale-changed'); }
		});

		test('locale case-insensitive', () => {
			const r = decideNlsLiveReload({
				previous: snap('RU', new Map([['a', 'А']])),
				current: snap('ru', new Map([['a', 'А']])),
			});
			assert.strictEqual(r.kind, 'no-op');
		});

		test('added key reported', () => {
			const r = decideNlsLiveReload({
				previous: snap('ru', new Map([['a', 'А']])),
				current: snap('ru', new Map([['a', 'А'], ['b', 'Б']])),
			});
			assert.strictEqual(r.kind, 'reload-keys');
			if (r.kind === 'reload-keys') {
				assert.deepStrictEqual([...r.addedKeys], ['b']);
				assert.deepStrictEqual([...r.modifiedKeys], []);
			}
		});

		test('modified key reported', () => {
			const r = decideNlsLiveReload({
				previous: snap('ru', new Map([['a', 'А']])),
				current: snap('ru', new Map([['a', 'А-обновлён']])),
			});
			if (r.kind === 'reload-keys') { assert.deepStrictEqual([...r.modifiedKeys], ['a']); }
		});

		test('removed key reported', () => {
			const r = decideNlsLiveReload({
				previous: snap('ru', new Map([['a', 'А'], ['b', 'Б']])),
				current: snap('ru', new Map([['a', 'А']])),
			});
			if (r.kind === 'reload-keys') { assert.deepStrictEqual([...r.removedKeys], ['b']); }
		});

		test('keys sorted in output', () => {
			const r = decideNlsLiveReload({
				previous: snap('ru', new Map()),
				current: snap('ru', new Map([['z', 'З'], ['a', 'А'], ['m', 'М']])),
			});
			if (r.kind === 'reload-keys') {
				assert.deepStrictEqual([...r.addedKeys], ['a', 'm', 'z']);
			}
		});

		test('over-threshold → full-reload:too-many-changes', () => {
			const prev = new Map<string, string>();
			for (let i = 0; i < 5; i++) { prev.set(`k${i}`, `v${i}`); }
			const curr = new Map<string, string>();
			for (let i = 0; i < 70; i++) { curr.set(`k${i}`, `v${i}-new`); }
			const r = decideNlsLiveReload({
				previous: snap('ru', prev),
				current: snap('ru', curr),
			});
			assert.strictEqual(r.kind, 'full-reload');
			if (r.kind === 'full-reload') {
				assert.strictEqual(r.reason, 'too-many-changes');
				assert.ok(r.changeCount && r.changeCount > 50);
			}
		});

		test('custom threshold respected', () => {
			const prev = new Map<string, string>();
			const curr = new Map<string, string>();
			for (let i = 0; i < 10; i++) { curr.set(`k${i}`, `v${i}`); }
			const r = decideNlsLiveReload({
				previous: snap('ru', prev),
				current: snap('ru', curr),
				fullReloadThreshold: 5,
			});
			assert.strictEqual(r.kind, 'full-reload');
		});
	});

	suite('buildNlsBundleSnapshot', () => {
		test('per-key hashes computed via injected fn', () => {
			const s = buildNlsBundleSnapshot('ru', new Map([['a', 'А']]), fnv1a32);
			assert.ok(s.perKeyHash.has('a'));
			assert.strictEqual(s.perKeyHash.get('a'), fnv1a32('А'));
		});

		test('aggregate hash deterministic', () => {
			const a = buildNlsBundleSnapshot('ru', new Map([['a', 'А'], ['b', 'Б']]), fnv1a32);
			const b = buildNlsBundleSnapshot('ru', new Map([['b', 'Б'], ['a', 'А']]), fnv1a32);
			assert.strictEqual(a.bundleHash, b.bundleHash);
		});

		test('aggregate hash differs on value change', () => {
			const a = buildNlsBundleSnapshot('ru', new Map([['a', 'А']]), fnv1a32);
			const b = buildNlsBundleSnapshot('ru', new Map([['a', 'Б']]), fnv1a32);
			assert.notStrictEqual(a.bundleHash, b.bundleHash);
		});

		test('empty map → empty snapshot but valid hash', () => {
			const s = buildNlsBundleSnapshot('ru', new Map(), fnv1a32);
			assert.strictEqual(s.perKeyHash.size, 0);
			assert.ok(s.bundleHash.length > 0);
		});
	});

	suite('fnv1a32', () => {
		test('deterministic', () => {
			assert.strictEqual(fnv1a32('hello'), fnv1a32('hello'));
		});
		test('different inputs differ', () => {
			assert.notStrictEqual(fnv1a32('a'), fnv1a32('b'));
		});
		test('returns 8-char hex', () => {
			assert.match(fnv1a32('test'), /^[0-9a-f]{8}$/);
		});
		test('empty string OK', () => {
			assert.match(fnv1a32(''), /^[0-9a-f]{8}$/);
		});
	});

	suite('groupKeysByPrefix', () => {
		test('groups by 2-segment prefix by default', () => {
			const r = groupKeysByPrefix([
				'vibeide.chat.send',
				'vibeide.chat.cancel',
				'vibeide.commands.run',
			]);
			assert.strictEqual(r.length, 2);
			const groups: Record<string, readonly string[]> = {};
			for (const g of r) { groups[g.prefix] = g.keys; }
			assert.deepStrictEqual(groups['vibeide.chat'], ['vibeide.chat.send', 'vibeide.chat.cancel']);
			assert.deepStrictEqual(groups['vibeide.commands'], ['vibeide.commands.run']);
		});

		test('depth=1 → single segment', () => {
			const r = groupKeysByPrefix(['a.b.c', 'a.x.y', 'b.c.d'], 1);
			assert.strictEqual(r.length, 2);
		});

		test('groups sorted by prefix', () => {
			const r = groupKeysByPrefix(['z.a', 'a.b', 'm.c']);
			assert.deepStrictEqual(r.map(g => g.prefix), ['a.b', 'm.c', 'z.a']);
		});

		test('empty input', () => {
			assert.deepStrictEqual(groupKeysByPrefix([]), []);
		});
	});
});
