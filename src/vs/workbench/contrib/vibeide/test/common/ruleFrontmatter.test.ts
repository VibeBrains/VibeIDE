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

suite('ruleFrontmatter — формы списка в шапке: triggers и globs', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/** Header of a rule file with one list key, parsed the way the rules service parses it. */
	const metaOf = (header: string) => {
		const { frontmatter } = parseRuleFrontmatter(`---\n${header}\n---\nbody`);
		return { triggers: parseTriggers(frontmatter), globs: parseGlobs(frontmatter) };
	};

	test('triggers в скобках: первая и последняя фраза не теряют скобку', () => {
		assert.deepStrictEqual(metaOf('triggers: [deploy, release]').triggers, ['deploy', 'release']);
		assert.deepStrictEqual(metaOf('triggers: ["Deploy", \'CI\', "ночной прогон"]').triggers, ['deploy', 'ci', 'ночной прогон']);
		assert.deepStrictEqual(metaOf('triggers: [ one ]').triggers, ['one']);
		assert.deepStrictEqual(metaOf('triggers: []').triggers, []);
	});

	test('triggers в скобках включают правило по первой и по последней фразе', () => {
		const { triggers } = metaOf('triggers: [deploy, release]');
		const activationOn = (userText: string) => decideRuleActivation({ alwaysApply: false, triggers, globs: [] }, { userText });
		assert.deepStrictEqual(
			{ first: activationOn('please deploy now'), last: activationOn('time for a release'), none: activationOn('hello') },
			{ first: 'inject', last: 'inject', none: 'index' },
		);
	});

	test('triggers YAML-списком с дефисами, с кавычками и без', () => {
		assert.deepStrictEqual(
			metaOf('description: x\ntriggers:\n  - "Ночной прогон"\n  - автопилот\n  - \'skip on failure\'\nalwaysApply: false').triggers,
			['ночной прогон', 'автопилот', 'skip on failure'],
		);
		// A list written at the key's own indentation is valid YAML too
		assert.deepStrictEqual(metaOf('triggers:\n- one\n- two').triggers, ['one', 'two']);
		// CRLF checkout of the same file
		const { frontmatter } = parseRuleFrontmatter('---\r\ntriggers:\r\n  - one\r\n  - two\r\n---\r\nbody');
		assert.deepStrictEqual(parseTriggers(frontmatter), ['one', 'two']);
	});

	test('пустой ключ без пунктов остаётся пустым и не съедает соседний ключ', () => {
		const { frontmatter } = parseRuleFrontmatter('---\nglobs:\nalwaysApply: false\n---\nbody');
		assert.deepStrictEqual({ globs: parseGlobs(frontmatter), alwaysApply: parseAlwaysApply(frontmatter) }, { globs: [], alwaysApply: false });
	});

	test('запятая внутри фигурных скобок glob не делит список', () => {
		assert.deepStrictEqual(metaOf('globs: **/*.{css,scss,less}').globs, ['**/*.{css,scss,less}']);
		assert.deepStrictEqual(metaOf('globs: **/*.{css,scss}, docs/**/*.md').globs, ['**/*.{css,scss}', 'docs/**/*.md']);
		assert.deepStrictEqual(metaOf('globs: src/{a,b}/*.{ts,tsx},*.md').globs, ['src/{a,b}/*.{ts,tsx}', '*.md']);
		// Nested braces
		assert.deepStrictEqual(metaOf('globs: src/{a,{b,c}}/*.ts, x.md').globs, ['src/{a,{b,c}}/*.ts', 'x.md']);
	});

	test('запятая внутри квадратных скобок glob не делит список, а скобки класса символов не снимаются', () => {
		assert.deepStrictEqual(metaOf('globs: src/[a,b].ts, *.md').globs, ['src/[a,b].ts', '*.md']);
		assert.deepStrictEqual(metaOf('globs: [ab]*.ts').globs, ['[ab]*.ts']);
		assert.deepStrictEqual(metaOf('globs: [ab]*.ts, src/*.md').globs, ['[ab]*.ts', 'src/*.md']);
	});

	test('globs в скобках-списке и YAML-списком, фигурные скобки внутри пункта целы', () => {
		assert.deepStrictEqual(metaOf('globs: ["**/*.{css,scss}", "*.md"]').globs, ['**/*.{css,scss}', '*.md']);
		assert.deepStrictEqual(metaOf('globs:\n  - **/*.{css,scss,less}\n  - "docs/**/*.md"').globs, ['**/*.{css,scss,less}', 'docs/**/*.md']);
	});

	test('запятая в кавычках не делит: фраза с запятой остаётся одной', () => {
		assert.deepStrictEqual(metaOf('triggers: "fix, then deploy", ci').triggers, ['fix, then deploy', 'ci']);
		assert.deepStrictEqual(metaOf('triggers:\n  - "fix, then deploy"\n  - ci').triggers, ['fix, then deploy', 'ci']);
		// An apostrophe inside a word is not a quote
		assert.deepStrictEqual(metaOf("triggers: don't stop, go on").triggers, ["don't stop", 'go on']);
	});

	test('glob с фигурными скобками срабатывает на подходящем файле и молчит на чужом', () => {
		const { globs } = metaOf('globs: **/*.{css,scss,less}');
		const activationOn = (file: string) => decideRuleActivation({ alwaysApply: false, triggers: [], globs }, { files: [file] });
		assert.deepStrictEqual(
			{ scss: activationOn('a.scss'), nested: activationOn('src/ui/a.less'), css: activationOn('a.css'), ts: activationOn('a.ts'), tsx: activationOn('src/a.tsx') },
			{ scss: 'inject', nested: 'inject', css: 'inject', ts: 'index', tsx: 'index' },
		);
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
