/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { DocsSection, formatHits, queryTerms, searchDocs, splitIntoSections } from '../../common/docsSearch.js';

suite('docsSearch', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const SPEC = [
		'# Спецификация формата .vibe/servers.json',
		'',
		'Вступление про дев-стек проекта.',
		'',
		'## Поля записи',
		'',
		'Обязательные: id и command.',
		'',
		'## Проверки готовности',
		'',
		'readyCheck: port, http, log, exit, spawn.',
	].join('\n');

	test('splits a document into heading-scoped sections, keeping the preamble', () => {
		assert.deepStrictEqual(
			splitIntoSections('manuals/serversSpec.md', SPEC).map(s => ({ h: s.heading, lvl: s.level, line: s.line, body: s.body })),
			[
				{ h: 'Спецификация формата .vibe/servers.json', lvl: 1, line: 1, body: 'Вступление про дев-стек проекта.' },
				{ h: 'Поля записи', lvl: 2, line: 5, body: 'Обязательные: id и command.' },
				{ h: 'Проверки готовности', lvl: 2, line: 9, body: 'readyCheck: port, http, log, exit, spawn.' },
			],
		);
	});

	test('text before the first heading becomes a level-0 section rather than being dropped', () => {
		const sections = splitIntoSections('a.md', 'Просто текст без заголовков.');
		assert.deepStrictEqual(
			sections.map(s => ({ h: s.heading, lvl: s.level, body: s.body })),
			[{ h: '', lvl: 0, body: 'Просто текст без заголовков.' }],
		);
	});

	test('query terms are normalised, deduplicated and stripped of noise-length fragments', () => {
		assert.deepStrictEqual(queryTerms('  Как  создать   servers.json? servers  я  '), ['как', 'создать', 'servers.json', 'servers']);
	});

	const sections: DocsSection[] = [
		...splitIntoSections('manuals/serversSpec.md', SPEC),
		...splitIntoSections('manuals/designWorkflow.md', '# Дизайнер\n\nПроверки страницы.\n\n## Три класса находок\n\nОшибка, предупреждение, замечание.'),
	];

	test('a heading match outranks a passing mention in prose', () => {
		const [top] = searchDocs(sections, 'проверки готовности');
		assert.deepStrictEqual(
			{ file: top.section.file, heading: top.section.heading },
			{ file: 'manuals/serversSpec.md', heading: 'Проверки готовности' },
		);
	});

	test('the file name itself is searchable — asking by filename finds the spec', () => {
		const hits = searchDocs(sections, 'servers.json');
		assert.strictEqual(hits[0].section.file, 'manuals/serversSpec.md');
	});

	test('sections matching nothing are omitted, not returned with score zero', () => {
		assert.deepStrictEqual(searchDocs(sections, 'кубернетес'), []);
		assert.deepStrictEqual(searchDocs(sections, ''), []);
	});

	test('limit is honoured and results are ordered by score', () => {
		const hits = searchDocs(sections, 'проверки', 2);
		assert.ok(hits.length <= 2, `ожидалось не более 2 попаданий, пришло ${hits.length}`);
		assert.ok(hits.every((h, i) => i === 0 || hits[i - 1].score >= h.score), 'порядок по убыванию score нарушен');
	});

	test('a heading term beats the all-terms bonus — the spec wins over a passing mention', () => {
		// Measured on the real corpus: the feature catalogue mentioned both «создай» and
		// «servers.json» in one paragraph and collected the all-terms bonus, pushing the spec's own
		// heading to second place. The heading is the author naming the topic — it has to win.
		const corpus = [
			...splitIntoSections('manuals/spec.md', '# Формат servers.json\n\nПоля и примеры.'),
			...splitIntoSections('catalogue.md', '# Возможности\n\nМожно сказать «создай servers.json» и получить файл.'),
		];
		assert.strictEqual(searchDocs(corpus, 'создай servers.json')[0].section.file, 'manuals/spec.md');
	});

	test('a long section does not outrank a focused one on bulk alone', () => {
		// Measured on the real corpus before the saturation cap: the sprawling «Vibe Server» entry
		// in functional.md beat the design manual's own section purely by repeating the term.
		const corpus = [
			...splitIntoSections('focused.md', `# Детектор\n\nПро детектор коротко и по делу.`),
			...splitIntoSections('sprawling.md', `# Каталог\n\n${'детектор упоминается тут. '.repeat(40)}`),
		];
		const [top] = searchDocs(corpus, 'детектор');
		assert.strictEqual(top.section.file, 'focused.md');
	});

	test('a short section is returned in full — a cut table is useless', () => {
		// The first live run failed here: the model got 320 chars of the spec's field table and
		// answered "the table is not available to me".
		const table = '| Поле | Смысл |\n|---|---|\n| id | ключ |\n| command | команда |';
		const [hit] = searchDocs(splitIntoSections('spec.md', `# Поля\n\n${table}`), 'поле');
		assert.strictEqual(hit.excerpt, table);
	});

	test('a heading with no prose of its own is not returned — its content lives in child sections', () => {
		// Both sections match the query; only the one with actual prose is worth citing.
		const corpus = splitIntoSections('spec.md', '# Поля записи\n\n## Обязательные\n\nОбязательные поля записи: id и command.');
		const hits = searchDocs(corpus, 'поля записи');
		assert.deepStrictEqual(hits.map(h => h.section.heading), ['Обязательные']);
	});

	test('excerpt centres on the match and marks truncation', () => {
		// Past FULL_SECTION_CHARS, so the excerpt path is what runs here.
		const long = splitIntoSections('m.md', `# Раздел\n\n${'вода '.repeat(400)}ИСКОМОЕ ${'вода '.repeat(400)}`);
		const [hit] = searchDocs(long, 'искомое');
		assert.ok(hit.excerpt.toLowerCase().includes('искомое'), 'выдержка не содержит совпадения');
		assert.ok(hit.excerpt.startsWith('…') && hit.excerpt.endsWith('…'), `выдержка не помечена обрезкой: ${hit.excerpt.slice(0, 40)}`);
	});

	test('formatted output cites file, heading and line — a claim can be checked', () => {
		const hits = searchDocs(sections, 'проверки готовности', 1);
		assert.strictEqual(
			formatHits(hits),
			'**manuals/serversSpec.md › Проверки готовности** (строка 9)\nreadyCheck: port, http, log, exit, spawn.',
		);
		assert.strictEqual(formatHits([]), '');
	});
});
