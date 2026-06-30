/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import * as assert from 'assert';
import { parseRuleFrontmatter, isRuleFileName, isAlwaysApply, parseAlwaysApply, parseTriggers, parseGlobs, matchesAnyTrigger, decideRuleActivation, ruleGlobsMatchAnyFile, extractToolFilePaths, toWorkspaceRelative, ruleNameFromPath, parseRuleInvocations } from '../../common/prompt/ruleFrontmatter.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';

suite('ruleFrontmatter — .mdc frontmatter parsing (R.1)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('no frontmatter → empty meta, body unchanged', () => {
		const r = parseRuleFrontmatter('# Rule\n\nDo the thing.');
		assert.deepStrictEqual(r.frontmatter, {});
		assert.strictEqual(r.body, '# Rule\n\nDo the thing.');
	});

	test('parses frontmatter and strips it from body', () => {
		const r = parseRuleFrontmatter('---\ndescription: When editing TS\nglobs: src/**/*.ts\nalwaysApply: true\n---\nUse tabs.');
		assert.strictEqual(r.frontmatter['description'], 'When editing TS');
		assert.strictEqual(r.frontmatter['globs'], 'src/**/*.ts');
		assert.strictEqual(r.frontmatter['alwaysapply'], 'true');
		assert.strictEqual(r.body, 'Use tabs.');
	});

	test('CRLF line endings tolerated', () => {
		const r = parseRuleFrontmatter('---\r\ndescription: x\r\n---\r\nbody');
		assert.strictEqual(r.frontmatter['description'], 'x');
		assert.strictEqual(r.body, 'body');
	});

	test('frontmatter NOT at start is not parsed (body kept verbatim)', () => {
		const content = 'intro\n---\ndescription: x\n---\nbody';
		const r = parseRuleFrontmatter(content);
		assert.deepStrictEqual(r.frontmatter, {});
		assert.strictEqual(r.body, content);
	});

	test('empty frontmatter block → empty meta, body after', () => {
		const r = parseRuleFrontmatter('---\n\n---\nbody');
		assert.deepStrictEqual(r.frontmatter, {});
		assert.strictEqual(r.body, 'body');
	});

	test('isAlwaysApply: true / false / absent / mixed-case', () => {
		assert.strictEqual(isAlwaysApply({ alwaysapply: 'true' }), true);
		assert.strictEqual(isAlwaysApply({ alwaysapply: 'TRUE' }), true);
		assert.strictEqual(isAlwaysApply({ alwaysapply: 'false' }), false);
		assert.strictEqual(isAlwaysApply({}), false);
	});

	test('isRuleFileName matches .md/.mdc, rejects others', () => {
		assert.strictEqual(isRuleFileName('dev-engine.mdc'), true);
		assert.strictEqual(isRuleFileName('rules.md'), true);
		assert.strictEqual(isRuleFileName('RULES.MD'), true);
		assert.strictEqual(isRuleFileName('notes.txt'), false);
		assert.strictEqual(isRuleFileName('script.mdc.bak'), false);
	});
});

suite('ruleFrontmatter — activation engine (R.7 / R.3)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('parseAlwaysApply tri-state: true / false / absent', () => {
		assert.strictEqual(parseAlwaysApply({ alwaysapply: 'true' }), true);
		assert.strictEqual(parseAlwaysApply({ alwaysapply: 'false' }), false);
		assert.strictEqual(parseAlwaysApply({}), undefined);
	});

	test('parseTriggers: quoted/unquoted, comma-separated, lowercased', () => {
		assert.deepStrictEqual(parseTriggers({ triggers: '"Deploy", "CI", release' }), ['deploy', 'ci', 'release']);
		assert.deepStrictEqual(parseTriggers({}), []);
		assert.deepStrictEqual(parseTriggers({ triggers: ' , "" , x ' }), ['x']);
	});

	test('parseGlobs: case preserved, quotes stripped', () => {
		assert.deepStrictEqual(parseGlobs({ globs: 'src/**/*.ts, "*.TSX"' }), ['src/**/*.ts', '*.TSX']);
	});

	test('matchesAnyTrigger: whole-word, case-insensitive, no partial match', () => {
		assert.strictEqual(matchesAnyTrigger(['deploy'], 'please deploy now'), true);
		assert.strictEqual(matchesAnyTrigger(['deploy'], 'PLEASE DEPLOY NOW'), true);
		assert.strictEqual(matchesAnyTrigger(['cat'], 'category theory'), false); // not a partial match
		assert.strictEqual(matchesAnyTrigger(['ci'], 'fix the build'), false);
	});

	test('matchesAnyTrigger: Cyrillic word boundary works', () => {
		assert.strictEqual(matchesAnyTrigger(['релиз'], 'готовим релиз сегодня'), true);
		assert.strictEqual(matchesAnyTrigger(['релиз'], 'релизный процесс'), false); // релизный ≠ релиз
	});

	test('decideRuleActivation: alwaysApply true → inject', () => {
		assert.strictEqual(decideRuleActivation({ alwaysApply: true, triggers: [], globs: [] }, {}), 'inject');
	});

	test('decideRuleActivation: triggers match → inject, miss → index', () => {
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: ['deploy'], globs: [] }, { userText: 'time to deploy' }), 'inject');
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: ['deploy'], globs: [] }, { userText: 'hello world' }), 'index');
	});

	test('decideRuleActivation: alwaysApply:false without match → index (agent-requested)', () => {
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: [], globs: [] }, { userText: 'anything' }), 'index');
	});

	test('decideRuleActivation: globs match a context file → inject (R.2)', () => {
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: [], globs: ['src/**/*.tsx'] }, { files: ['src/ui/Button.tsx'] }), 'inject');
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: [], globs: ['*.tsx'] }, { files: ['src/ui/Button.tsx'] }), 'inject'); // basename fallback
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: [], globs: ['src/**/*.tsx'] }, { files: ['lib/util.ts'] }), 'index'); // no match → index
		assert.strictEqual(decideRuleActivation({ alwaysApply: false, triggers: [], globs: ['*.ts'] }, {}), 'index'); // no files → index
	});

	test('decideRuleActivation: plain rule (no frontmatter) → inject (back-compat)', () => {
		assert.strictEqual(decideRuleActivation({ alwaysApply: undefined, triggers: [], globs: [] }, {}), 'inject');
	});

	test('ruleGlobsMatchAnyFile: matches path globs + basename fallback', () => {
		assert.strictEqual(ruleGlobsMatchAnyFile(['src/**/*.ts'], ['src/a/b.ts']), true);
		assert.strictEqual(ruleGlobsMatchAnyFile(['*.md'], ['docs/readme.md']), true); // no-slash glob → basename
		assert.strictEqual(ruleGlobsMatchAnyFile(['src/*.ts'], ['src/a/b.ts']), false); // single * doesn't cross /
		assert.strictEqual(ruleGlobsMatchAnyFile([], ['a.ts']), false);
	});

	test('extractToolFilePaths: collects rawParams.uri from tool messages only', () => {
		const msgs = [
			{ role: 'user' },
			{ role: 'tool', rawParams: { uri: 'src/a.ts' } },
			{ role: 'assistant' },
			{ role: 'tool', rawParams: { pattern: 'x' } }, // no uri
			{ role: 'tool', rawParams: { uri: 'src/b.tsx' } },
		];
		assert.deepStrictEqual(extractToolFilePaths(msgs), ['src/a.ts', 'src/b.tsx']);
	});

	test('toWorkspaceRelative: strips workspace prefix, normalises slashes, case-insensitive', () => {
		assert.strictEqual(toWorkspaceRelative('d:\\proj\\src\\a.ts', ['d:\\proj']), 'src/a.ts');
		assert.strictEqual(toWorkspaceRelative('D:/Proj/src/a.ts', ['d:\\proj\\']), 'src/a.ts'); // trailing slash + case
		assert.strictEqual(toWorkspaceRelative('/other/x.ts', ['d:\\proj']), '/other/x.ts'); // outside ws → unchanged (normalised)
	});
});

suite('ruleFrontmatter — @rule invocation + naming (R.5)', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('ruleNameFromPath: basename without extension, lowercased', () => {
		assert.strictEqual(ruleNameFromPath('.vibe/rules/dev-engine.mdc'), 'dev-engine');
		assert.strictEqual(ruleNameFromPath('AGENTS.md'), 'agents');
		assert.strictEqual(ruleNameFromPath('.vibe\\rules\\Sub\\X.MD'), 'x');
	});

	test('parseRuleInvocations: @rule: and /rule:, deduped + lowercased', () => {
		assert.deepStrictEqual(parseRuleInvocations('use @rule:Deploy and /rule:ci please'), ['deploy', 'ci']);
		assert.deepStrictEqual(parseRuleInvocations('@rule:x @rule:x'), ['x']);
		assert.deepStrictEqual(parseRuleInvocations('no invocation here'), []);
		assert.deepStrictEqual(parseRuleInvocations(''), []);
	});
});
