/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { extractQueryTerms, rankDocsForTask } from '../../common/docsRetrieval.js';
import { IDocGraphEdge, IDocGraphNode, parseDocHeadings } from '../../common/vibeDocsGraph.js';

const node = (id: string, label: string, domain: string, headings: string[], degree = 0): IDocGraphNode =>
	({ id, label, domain, degree, reachable: true, headings });

const NODES: IDocGraphNode[] = [
	node('architecture/modelQuirks.md', 'modelQuirks', 'architecture', ['Каталог квирков моделей', 'Сэмплинг и вызовы инструментов']),
	node('ui/designReview.md', 'designReview', 'ui', ['Детекторы сгенерированного дизайна', 'Прокси: мост в чужом dev-сервере']),
	node('testing/electronTestPollution.md', 'electronTestPollution', 'testing', ['Заражение тестов таймерами']),
	node('architecture/dynamicProviders.md', 'dynamicProviders', 'architecture', ['Конфиг-провайдеры равны встроенным']),
];

const EDGES: IDocGraphEdge[] = [
	{ from: 'architecture/modelQuirks.md', to: 'architecture/dynamicProviders.md', kind: 'wiki' },
];

suite('docsRetrieval — библиотекарь без LLM', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('короткие слова отбрасываются, регистр и повторы схлопываются', () => {
		assert.deepStrictEqual(extractQueryTerms('Не из ДЕТЕКТОР детектор до'), ['детектор']);
	});

	test('находит по заголовку, а не только по имени файла', () => {
		const hits = rankDocsForTask('почему сломался прокси в превью', NODES, [], 3);
		assert.deepStrictEqual(hits.map(h => h.id), ['ui/designReview.md']);
	});

	test('совпадение по имени весит больше, чем по домену', () => {
		const hits = rankDocsForTask('правило квирков для новой модели', NODES, [], 4);
		assert.strictEqual(hits[0].id, 'architecture/modelQuirks.md');
	});

	test('сосед по ссылке приходит следом за найденным и помечен именно так', () => {
		const hits = rankDocsForTask('квирков', NODES, EDGES, 4);
		assert.deepStrictEqual(
			hits.map(h => [h.id, h.why.startsWith('связана') ? 'сосед' : 'прямое']),
			[['architecture/modelQuirks.md', 'прямое'], ['architecture/dynamicProviders.md', 'сосед']],
		);
	});

	test('нет совпадений — пустой результат, а не «на всякий случай» весь корпус', () => {
		assert.deepStrictEqual(
			[rankDocsForTask('квантовая хромодинамика', NODES, EDGES, 5), rankDocsForTask('', NODES, EDGES, 5)],
			[[], []],
		);
	});

	test('порядок детерминирован при равном весе — иначе один корпус даёт разный промпт', () => {
		const twins = [node('a/one.md', 'детектор', 'a', []), node('b/two.md', 'детектор', 'b', [])];
		assert.deepStrictEqual(
			rankDocsForTask('детектор', twins, [], 2).map(h => h.id),
			['a/one.md', 'b/two.md'],
		);
	});

	test('заголовки: код в ограде не считается заголовком', () => {
		const md = '# Настоящий\n\n```sh\n# это комментарий, а не заголовок\n```\n\n## Второй\n';
		assert.deepStrictEqual(parseDocHeadings(md), ['Настоящий', 'Второй']);
	});
});
