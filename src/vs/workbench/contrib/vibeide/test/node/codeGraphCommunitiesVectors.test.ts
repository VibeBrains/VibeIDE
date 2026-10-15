/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Деление проекта на подсистемы обязано давать то же разбиение и те же подписи в обоих продуктах
 * Общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/codeGraphCommunities.json`): малый граф файлов и связей → подсистемы и одиночки
 * Номера подсистем не сравниваются: разбиение — множество множеств путей, у каждого подпись
 *
 * Результат не зависит от порядка `files` и `links`, и тест это проверяет: каждый случай идёт в нескольких перестановках входа
 * Незнакомое поле роняет тест: выросший контракт надо прочитать, а не пропустить
 * Файл читается через `fs`, поэтому тест живёт в `test/node/`
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { analyzeCodeGraph } from '../../common/codeGraph/codeGraphAnalysis.js';
import { CodeGraph, EdgeProvenance, fileNodeId } from '../../common/codeGraph/vibeCodeGraph.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в modelEchoVectors.test.ts */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

const FILE_FIELDS = ['_comment', 'cases', 'version'];
const CASE_FIELDS = ['files', 'isolated', 'links', 'subsystems', 'why'];
const LINK_FIELDS = ['from', 'provenance', 'to'];
const SUBSYSTEM_FIELDS = ['files', 'label'];
/** Происхождения, которые векторы разрешают: `inferred` продукты взвешивают по-разному и в общий набор он не входит */
const VECTOR_PROVENANCES: readonly EdgeProvenance[] = ['extracted', 'ambiguous'];
const READ_VERSION = 1;

interface VectorLink {
	readonly from: string;
	readonly to: string;
	readonly provenance: EdgeProvenance;
}

interface VectorSubsystem {
	readonly label: string;
	readonly files: readonly string[];
}

interface CommunitiesCase {
	readonly why: string;
	readonly files: readonly string[];
	readonly links: readonly VectorLink[];
	readonly subsystems: readonly VectorSubsystem[];
	readonly isolated: readonly string[];
}

interface CommunitiesVectors {
	readonly version: number;
	readonly cases: readonly CommunitiesCase[];
}

/** The graph of a case: one node per file, one `imports` edge per link, in the order given */
function graphOf(files: readonly string[], links: readonly VectorLink[]): CodeGraph {
	return {
		nodes: files.map(file => ({ id: fileNodeId(file), kind: 'file' as const, label: file, file })),
		edges: links.map(link => ({ from: fileNodeId(link.from), to: fileNodeId(link.to), kind: 'imports' as const, provenance: link.provenance })),
	};
}

/** Subsystems as a set of sets: groups ordered by their first file, files by name; ids never take part */
function normalized(subsystems: readonly VectorSubsystem[]): VectorSubsystem[] {
	return subsystems
		.map(subsystem => ({ label: subsystem.label, files: [...subsystem.files].sort() }))
		.sort((a, b) => a.files[0].localeCompare(b.files[0]));
}

/** A repeatable shuffle: Math.random would make a failure impossible to replay */
function shuffled<T>(items: readonly T[], seed: number): T[] {
	let state = seed;
	const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
	const out = [...items];
	for (let i = out.length - 1; i > 0; i--) {
		const j = Math.floor(next() * (i + 1));
		[out[i], out[j]] = [out[j], out[i]];
	}
	return out;
}

suite('граф проекта — общие с VibeIDEA векторы деления на подсистемы', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const raw: Record<string, unknown> = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'codeGraphCommunities.json'), 'utf8'));
	const vectors = raw as unknown as CommunitiesVectors;

	test('файл той версии и того состава, что читает этот тест', () => {
		const fieldsOf = (lists: readonly (readonly object[])[]) => [...new Set(lists.flatMap(list => list.flatMap(item => Object.keys(item))))].sort();
		assert.deepStrictEqual({
			version: vectors.version,
			fileFields: Object.keys(raw).sort(),
			caseFields: fieldsOf([vectors.cases]),
			linkFields: fieldsOf(vectors.cases.map(c => c.links)),
			subsystemFields: fieldsOf(vectors.cases.map(c => c.subsystems)),
			provenances: [...new Set(vectors.cases.flatMap(c => c.links.map(link => link.provenance)))].sort(),
			cases: vectors.cases.length > 0,
		}, {
			version: READ_VERSION,
			fileFields: FILE_FIELDS,
			caseFields: CASE_FIELDS,
			linkFields: LINK_FIELDS,
			subsystemFields: SUBSYSTEM_FIELDS,
			provenances: [...VECTOR_PROVENANCES].sort(),
			cases: true,
		});
	});

	test('разбиение, подписи и одиночки совпадают в каждой перестановке входа', () => {
		const permutations: { readonly name: string; readonly order: (c: CommunitiesCase) => { files: readonly string[]; links: readonly VectorLink[] } }[] = [
			{ name: 'как в файле', order: c => ({ files: c.files, links: c.links }) },
			{ name: 'файлы и связи в обратном порядке', order: c => ({ files: [...c.files].reverse(), links: [...c.links].reverse() }) },
			{ name: 'файлы вразнобой', order: c => ({ files: shuffled(c.files, 11), links: c.links }) },
			{ name: 'связи вразнобой', order: c => ({ files: c.files, links: shuffled(c.links, 23) }) },
			{ name: 'всё вразнобой', order: c => ({ files: shuffled(c.files, 5), links: shuffled(c.links, 101) }) },
		];
		const actual = vectors.cases.flatMap(c => permutations.map(permutation => {
			const { files, links } = permutation.order(c);
			const analysis = analyzeCodeGraph(graphOf(files, links));
			return {
				case: `${c.why} [${permutation.name}]`,
				subsystems: normalized(analysis.subsystems.map(subsystem => ({ label: subsystem.label, files: subsystem.files }))),
				isolated: [...analysis.report.isolated].sort(),
			};
		}));
		const expected = vectors.cases.flatMap(c => permutations.map(permutation => ({
			case: `${c.why} [${permutation.name}]`,
			subsystems: normalized(c.subsystems),
			isolated: [...c.isolated].sort(),
		})));
		assert.deepStrictEqual(actual, expected);
	});
});
