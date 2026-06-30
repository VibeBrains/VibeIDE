/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import {
	QUICK_EDIT_SLASH_COMMANDS,
	expandQuickEditSlashCommand,
	quickEditSlashHintNames,
} from '../../common/quickEditTemplates.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('Ctrl+K Quick Edit slash-command templates — pure', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	suite('QUICK_EDIT_SLASH_COMMANDS catalog', () => {
		test('contains the seven built-in commands', () => {
			const names = QUICK_EDIT_SLASH_COMMANDS.map(c => c.name);
			assert.deepStrictEqual(
				names.slice().sort(),
				['doc', 'explain', 'fix', 'optimize', 'refactor', 'tests', 'typehints'],
			);
		});

		test('every command has a non-empty prompt and description', () => {
			for (const c of QUICK_EDIT_SLASH_COMMANDS) {
				assert.ok(c.prompt.length > 20, `prompt too short for /${c.name}`);
				assert.ok(c.description.length > 0, `description missing for /${c.name}`);
			}
		});

		test('command names are lowercase-only', () => {
			for (const c of QUICK_EDIT_SLASH_COMMANDS) {
				assert.strictEqual(c.name, c.name.toLowerCase(), `/${c.name} must be lowercase`);
				assert.ok(/^[a-z][a-z0-9_-]*$/.test(c.name), `/${c.name} must match the slash-command regex`);
			}
		});
	});

	suite('expandQuickEditSlashCommand — built-in matching', () => {
		test('matches /doc and returns the doc template', () => {
			const r = expandQuickEditSlashCommand('/doc');
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.strictEqual(r.command, 'doc');
				assert.ok(r.expanded.toLowerCase().includes('documentation'));
			}
		});

		test('matches all seven built-in commands', () => {
			for (const c of QUICK_EDIT_SLASH_COMMANDS) {
				const r = expandQuickEditSlashCommand(`/${c.name}`);
				assert.strictEqual(r.matched, true, `expected match for /${c.name}`);
				if (r.matched) {
					assert.strictEqual(r.command, c.name);
					assert.strictEqual(r.expanded, c.prompt);
				}
			}
		});

		test('is case-insensitive on the command name', () => {
			const r = expandQuickEditSlashCommand('/DOC');
			assert.strictEqual(r.matched, true);
			if (r.matched) { assert.strictEqual(r.command, 'doc'); }
		});

		test('trims surrounding whitespace before matching', () => {
			const r = expandQuickEditSlashCommand('   /refactor   ');
			assert.strictEqual(r.matched, true);
			if (r.matched) { assert.strictEqual(r.command, 'refactor'); }
		});
	});

	suite('expandQuickEditSlashCommand — extra context append', () => {
		test('appends extra context after the template', () => {
			const r = expandQuickEditSlashCommand('/doc use Google docstring style');
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.ok(r.expanded.startsWith(QUICK_EDIT_SLASH_COMMANDS.find(c => c.name === 'doc')!.prompt));
				assert.ok(r.expanded.includes('Additional instructions: use Google docstring style'));
			}
		});

		test('trims extra context whitespace', () => {
			const r = expandQuickEditSlashCommand('/tests    cover null inputs   ');
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.ok(r.expanded.endsWith('Additional instructions: cover null inputs'));
			}
		});

		test('no Additional instructions block when extra context absent', () => {
			const r = expandQuickEditSlashCommand('/explain');
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.ok(!r.expanded.includes('Additional instructions:'));
			}
		});

		test('multiline extra context is preserved', () => {
			const r = expandQuickEditSlashCommand('/refactor\nline one\nline two');
			// Regex requires whitespace separator before extra context — `\n` qualifies as whitespace.
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.ok(r.expanded.includes('line one'));
				assert.ok(r.expanded.includes('line two'));
			}
		});
	});

	suite('expandQuickEditSlashCommand — no-match cases', () => {
		test('returns matched: false for empty string', () => {
			assert.deepStrictEqual(expandQuickEditSlashCommand(''), { matched: false });
		});

		test('returns matched: false for plain text (no leading slash)', () => {
			assert.deepStrictEqual(
				expandQuickEditSlashCommand('add error handling'),
				{ matched: false },
			);
		});

		test('returns matched: false for unknown slash-command', () => {
			assert.deepStrictEqual(
				expandQuickEditSlashCommand('/nonexistent'),
				{ matched: false },
			);
		});

		test('returns matched: false for slash without command name', () => {
			assert.deepStrictEqual(expandQuickEditSlashCommand('/'), { matched: false });
			assert.deepStrictEqual(expandQuickEditSlashCommand('/ '), { matched: false });
		});

		test('returns matched: false for non-string input', () => {
			// @ts-expect-error — runtime guard test
			assert.deepStrictEqual(expandQuickEditSlashCommand(null), { matched: false });
			// @ts-expect-error
			assert.deepStrictEqual(expandQuickEditSlashCommand(undefined), { matched: false });
			// @ts-expect-error
			assert.deepStrictEqual(expandQuickEditSlashCommand(42), { matched: false });
		});

		test('does not match slash-command preceded by other content', () => {
			assert.deepStrictEqual(
				expandQuickEditSlashCommand('please /doc this code'),
				{ matched: false },
			);
		});
	});

	suite('expandQuickEditSlashCommand — workspace overrides (R.3 forward-compat)', () => {
		test('workspace command shadows built-in', () => {
			const r = expandQuickEditSlashCommand('/doc', { doc: 'CUSTOM-DOC-TEMPLATE' });
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.strictEqual(r.expanded, 'CUSTOM-DOC-TEMPLATE');
			}
		});

		test('workspace command unknown to built-in is matched', () => {
			const r = expandQuickEditSlashCommand('/review', { review: 'REVIEW-TEMPLATE' });
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.strictEqual(r.command, 'review');
				assert.strictEqual(r.expanded, 'REVIEW-TEMPLATE');
			}
		});

		test('unknown name still does not match when extraCommands provided but empty', () => {
			const r = expandQuickEditSlashCommand('/nope', { other: 'X' });
			assert.deepStrictEqual(r, { matched: false });
		});

		test('workspace command supports extra context append', () => {
			const r = expandQuickEditSlashCommand('/review focus on naming', { review: 'REVIEW-TEMPLATE' });
			assert.strictEqual(r.matched, true);
			if (r.matched) {
				assert.strictEqual(r.expanded, 'REVIEW-TEMPLATE\n\nAdditional instructions: focus on naming');
			}
		});
	});

	suite('quickEditSlashHintNames', () => {
		test('returns at most maxShown commands prefixed with /', () => {
			const names = quickEditSlashHintNames(3);
			assert.strictEqual(names.length, 3);
			for (const n of names) {
				assert.ok(n.startsWith('/'), `${n} must start with /`);
			}
		});

		test('default maxShown is 5', () => {
			const names = quickEditSlashHintNames();
			assert.strictEqual(names.length, 5);
		});

		test('handles maxShown of 0 and negative', () => {
			assert.deepStrictEqual(quickEditSlashHintNames(0), []);
			assert.deepStrictEqual(quickEditSlashHintNames(-1), []);
		});

		test('caps at catalog length when maxShown exceeds it', () => {
			const names = quickEditSlashHintNames(999);
			assert.strictEqual(names.length, QUICK_EDIT_SLASH_COMMANDS.length);
		});
	});
});
