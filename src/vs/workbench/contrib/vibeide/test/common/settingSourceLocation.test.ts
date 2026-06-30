/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	decodeSourceLocation,
	buildSettingMetadataStamp,
	buildGoToTarget,
	indexStampsBySettingKey,
	resolveSettingSource,
	findSiblingSettings,
	SettingMetadataStamp,
} from '../../common/settingSourceLocation.js';

const validLoc = (overrides: Record<string, unknown> = {}): unknown => ({
	filePath: 'src/foo.ts',
	lineNumber: 42,
	localizeKey: 'vibeide.foo.title',
	...overrides,
});

suite('Settings UI Ctrl+Click — source-location metadata', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('decodeSourceLocation', () => {
		test('happy path', () => {
			const r = decodeSourceLocation(validLoc());
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.filePath, 'src/foo.ts');
				assert.strictEqual(r.value.lineNumber, 42);
				assert.strictEqual(r.value.localizeKey, 'vibeide.foo.title');
			}
		});

		test('rejects empty filePath', () => {
			const r = decodeSourceLocation(validLoc({ filePath: '   ' }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects zero/negative lineNumber', () => {
			assert.strictEqual(decodeSourceLocation(validLoc({ lineNumber: 0 })).ok, false);
			assert.strictEqual(decodeSourceLocation(validLoc({ lineNumber: -1 })).ok, false);
		});

		test('rejects non-integer lineNumber', () => {
			const r = decodeSourceLocation(validLoc({ lineNumber: 1.5 }));
			assert.strictEqual(r.ok, false);
		});

		test('rejects malformed localizeKey', () => {
			const r = decodeSourceLocation(validLoc({ localizeKey: '! invalid !' }));
			assert.strictEqual(r.ok, false);
		});

		test('trims filePath whitespace', () => {
			const r = decodeSourceLocation(validLoc({ filePath: '  src/foo.ts  ' }));
			if (r.ok) { assert.strictEqual(r.value.filePath, 'src/foo.ts'); }
		});

		test('rejects null root', () => {
			assert.strictEqual(decodeSourceLocation(null).ok, false);
		});
	});

	suite('buildSettingMetadataStamp', () => {
		test('happy path', () => {
			const r = buildSettingMetadataStamp({
				settingKey: 'vibeide.commands.toolbar.position',
				filePath: 'src/foo.ts',
				lineNumber: 42,
				localizeKey: 'vibeide.commands.toolbar.position.title',
			});
			assert.strictEqual(r.ok, true);
		});

		test('rejects malformed setting key (cannot start with digit)', () => {
			const r = buildSettingMetadataStamp({
				settingKey: '1bad',
				filePath: 'x',
				lineNumber: 1,
				localizeKey: 'k',
			});
			assert.strictEqual(r.ok, false);
		});

		test('rejects setting key with hyphen (must be dot-segment)', () => {
			const r = buildSettingMetadataStamp({
				settingKey: 'vibeide-commands',
				filePath: 'x',
				lineNumber: 1,
				localizeKey: 'k',
			});
			assert.strictEqual(r.ok, false);
		});

		test('forwards source-location validation', () => {
			const r = buildSettingMetadataStamp({
				settingKey: 'vibeide.x',
				filePath: '',
				lineNumber: 1,
				localizeKey: 'k',
			});
			assert.strictEqual(r.ok, false);
		});
	});

	suite('buildGoToTarget', () => {
		test('produces 0-based range from 1-based line', () => {
			const r = buildGoToTarget({ filePath: 'x.ts', lineNumber: 10, localizeKey: 'k' });
			assert.strictEqual(r.startLine0, 9);
			assert.strictEqual(r.endLine0, 9);
			assert.strictEqual(r.startCol0, 0);
		});

		test('end col approximates key location', () => {
			const r = buildGoToTarget({ filePath: 'x.ts', lineNumber: 1, localizeKey: 'short' });
			assert.ok(r.endCol0 > 'localize(\''.length);
		});

		test('clamps end col at 200', () => {
			const r = buildGoToTarget({
				filePath: 'x.ts',
				lineNumber: 1,
				localizeKey: 'k'.repeat(300),
			});
			assert.strictEqual(r.endCol0, 200);
		});

		test('forwards file path', () => {
			const r = buildGoToTarget({ filePath: 'src/x.ts', lineNumber: 1, localizeKey: 'k' });
			assert.strictEqual(r.filePath, 'src/x.ts');
		});
	});

	suite('indexStampsBySettingKey', () => {
		const a: SettingMetadataStamp = {
			settingKey: 'a.x',
			source: { filePath: 'a.ts', lineNumber: 1, localizeKey: 'a' },
		};
		const b: SettingMetadataStamp = {
			settingKey: 'b.y',
			source: { filePath: 'b.ts', lineNumber: 2, localizeKey: 'b' },
		};

		test('happy path', () => {
			const r = indexStampsBySettingKey([a, b]);
			assert.strictEqual(r.ok, true);
			if (r.ok) {
				assert.strictEqual(r.value.size, 2);
				assert.strictEqual(r.value.get('a.x'), a);
			}
		});

		test('rejects duplicate setting key', () => {
			const r = indexStampsBySettingKey([a, { ...a, source: { ...a.source, lineNumber: 99 } }]);
			assert.strictEqual(r.ok, false);
			if (!r.ok) { assert.ok(r.reason.includes('duplicate-setting')); }
		});

		test('empty input → empty index', () => {
			const r = indexStampsBySettingKey([]);
			if (r.ok) { assert.strictEqual(r.value.size, 0); }
		});
	});

	suite('resolveSettingSource', () => {
		test('returns source for known key', () => {
			const stamp: SettingMetadataStamp = {
				settingKey: 'a.x',
				source: { filePath: 'a.ts', lineNumber: 1, localizeKey: 'a' },
			};
			const idx = (indexStampsBySettingKey([stamp]) as { ok: true; value: ReadonlyMap<string, SettingMetadataStamp> }).value;
			const r = resolveSettingSource('a.x', idx);
			assert.ok(r);
			if (r) { assert.strictEqual(r.filePath, 'a.ts'); }
		});

		test('null for unknown key', () => {
			const idx = new Map<string, SettingMetadataStamp>();
			assert.strictEqual(resolveSettingSource('missing', idx), null);
		});
	});

	suite('findSiblingSettings', () => {
		test('returns settings declared at same file:line', () => {
			const a: SettingMetadataStamp = {
				settingKey: 'a',
				source: { filePath: 'shared.ts', lineNumber: 10, localizeKey: 'k' },
			};
			const b: SettingMetadataStamp = {
				settingKey: 'b',
				source: { filePath: 'shared.ts', lineNumber: 10, localizeKey: 'k' },
			};
			const c: SettingMetadataStamp = {
				settingKey: 'c',
				source: { filePath: 'other.ts', lineNumber: 10, localizeKey: 'k' },
			};
			const idx = (indexStampsBySettingKey([a, b, c]) as { ok: true; value: ReadonlyMap<string, SettingMetadataStamp> }).value;
			const r = findSiblingSettings('a', idx);
			assert.deepStrictEqual([...r], ['b']);
		});

		test('empty when key absent', () => {
			const idx = new Map<string, SettingMetadataStamp>();
			assert.deepStrictEqual([...findSiblingSettings('missing', idx)], []);
		});

		test('empty when no siblings', () => {
			const a: SettingMetadataStamp = {
				settingKey: 'a',
				source: { filePath: 'a.ts', lineNumber: 1, localizeKey: 'k' },
			};
			const idx = (indexStampsBySettingKey([a]) as { ok: true; value: ReadonlyMap<string, SettingMetadataStamp> }).value;
			assert.deepStrictEqual([...findSiblingSettings('a', idx)], []);
		});

		test('siblings sorted', () => {
			const stamps: SettingMetadataStamp[] = ['z', 'a', 'm'].map(k => ({
				settingKey: k,
				source: { filePath: 'shared.ts', lineNumber: 10, localizeKey: 'k' },
			}));
			const idx = (indexStampsBySettingKey(stamps) as { ok: true; value: ReadonlyMap<string, SettingMetadataStamp> }).value;
			const r = findSiblingSettings('a', idx);
			assert.deepStrictEqual([...r], ['m', 'z']);
		});
	});
});
