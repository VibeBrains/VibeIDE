/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Чекпоинт агентского хода — общие с VibeIDEA векторы из набора (`.vibe-defaults/testVectors/checkpoint.json`).
 *
 * Снимок, сделанный одним продуктом, обязан читаться другим: в одном репозитории работают оба. Контракт — `checkpointSpec.md`
 * рядом с векторами, здесь он прогоняется чистыми функциями продукта, без git. Настоящий репозиторий — `workspaceSnapshotRepo.test.ts`.
 *
 * Незнакомое поле в векторах роняет тест: выросший контракт надо прочитать, а не пропустить. Файл читается через `fs`,
 * поэтому тест живёт в `test/node/`.
 */

import * as assert from 'assert';
import { fileURLToPath } from 'url';
import { readFileSync } from 'fs';
// eslint-disable-next-line local/code-import-patterns -- node 'fs'/'path' в node-тесте (by design)
import { join } from 'path';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { checkpointCoverage, SHELL_TOOL_NAMES } from '../../common/checkpointCoverage.js';
import {
	parsePinnedSnapshots, parseSnapshotCommitMessage, planSnapshotRestore, selectStaleSnapshotRefs, shouldReuseSnapshot,
	SNAPSHOT_PRUNE_MIN_AGE_MS, snapshotCommitMessage, SnapshotCommitMeta, SnapshotMessageFields,
} from '../../common/workspaceSnapshotPolicy.js';

/** Корень репозитория от `out/vs/workbench/contrib/vibeide/test/node/` — как в mcpServersFileVectors.test.ts. */
const REPO_ROOT = join(fileURLToPath(import.meta.url), '..', '..', '..', '..', '..', '..', '..', '..');

interface Named { readonly name: string }

interface CommitMessageCase extends Named {
	readonly product: string;
	readonly tree: string;
	readonly meta: SnapshotCommitMeta;
	readonly expected: string;
}
interface ParseMessageCase extends Named { readonly message: string; readonly expected: SnapshotMessageFields }
interface ParsePinnedCase extends Named { readonly stdout: string; readonly expected: readonly { readonly id: string; readonly committedAtMs: number }[] }
interface StaleRefsCase extends Named {
	readonly nowMs: number;
	readonly pinned: readonly { readonly id: string; readonly committedAtMs: number }[];
	readonly live: readonly string[];
	readonly expected: readonly string[];
}
interface ReuseCase extends Named { readonly newTree: string; readonly previousTree: string | null; readonly expected: boolean }
interface RestorePlanCase extends Named {
	readonly snapshotPaths: readonly string[];
	readonly workingPaths: readonly string[];
	readonly ignoredPaths: readonly string[];
	readonly expected: { readonly restore: readonly string[]; readonly delete: readonly string[] };
}
interface CoverageCase extends Named {
	readonly hasSnapshot: boolean;
	readonly wouldChangeAnything: boolean | null;
	readonly toolNames: readonly string[];
	readonly expected: { readonly kind: string; readonly shellCallCount?: number };
}

interface CheckpointVectors {
	readonly _comment: string;
	readonly version: number;
	readonly pruneMinAgeMs: number;
	readonly shellToolNames: readonly string[];
	readonly commitMessage: readonly CommitMessageCase[];
	readonly parseMessage: readonly ParseMessageCase[];
	readonly parsePinned: readonly ParsePinnedCase[];
	readonly staleRefs: readonly StaleRefsCase[];
	readonly reuse: readonly ReuseCase[];
	readonly restorePlan: readonly RestorePlanCase[];
	readonly coverage: readonly CoverageCase[];
}

/** Version of the vector format this test understands. */
const SUPPORTED_VERSION = 1;

const SECTION_KEYS: Readonly<Record<string, readonly string[]>> = {
	commitMessage: ['name', 'product', 'tree', 'meta', 'expected'],
	parseMessage: ['name', 'message', 'expected'],
	parsePinned: ['name', 'stdout', 'expected'],
	staleRefs: ['name', 'nowMs', 'pinned', 'live', 'expected'],
	reuse: ['name', 'newTree', 'previousTree', 'expected'],
	restorePlan: ['name', 'snapshotPaths', 'workingPaths', 'ignoredPaths', 'expected'],
	coverage: ['name', 'hasSnapshot', 'wouldChangeAnything', 'toolNames', 'expected'],
};

const TOP_LEVEL_KEYS = ['_comment', 'version', 'pruneMinAgeMs', 'shellToolNames', ...Object.keys(SECTION_KEYS)];
const META_KEYS = ['turnIndex', 'toolName', 'threadId', 'agent', 'label'];
const MESSAGE_FIELD_KEYS = ['tree', 'turnIndex', 'toolName', 'threadId', 'agent', 'label'];
const PINNED_KEYS = ['id', 'committedAtMs'];
const PLAN_KEYS = ['restore', 'delete'];
const COVERAGE_RESULT_KEYS = ['kind', 'shellCallCount'];

/** Fields of the vectors this test does not know, as readable lines. */
function unknownFields(vectors: CheckpointVectors): string[] {
	const found: string[] = [];
	const check = (where: string, value: object, known: readonly string[]) => {
		for (const key of Object.keys(value).filter(key => !known.includes(key))) { found.push(`${where}: ${key}`); }
	};
	check('верхний уровень', vectors, TOP_LEVEL_KEYS);
	for (const [section, keys] of Object.entries(SECTION_KEYS)) {
		for (const entry of (vectors as unknown as Record<string, readonly { readonly name: string }[]>)[section]) {
			const where = `${section} «${entry.name}»`;
			check(where, entry, keys);
			switch (section) {
				case 'commitMessage': check(`${where} meta`, (entry as CommitMessageCase).meta, META_KEYS); break;
				case 'parseMessage': check(`${where} expected`, (entry as ParseMessageCase).expected, MESSAGE_FIELD_KEYS); break;
				case 'parsePinned': (entry as ParsePinnedCase).expected.forEach(ref => check(`${where} expected`, ref, PINNED_KEYS)); break;
				case 'staleRefs': (entry as StaleRefsCase).pinned.forEach(ref => check(`${where} pinned`, ref, PINNED_KEYS)); break;
				case 'restorePlan': check(`${where} expected`, (entry as RestorePlanCase).expected, PLAN_KEYS); break;
				case 'coverage': check(`${where} expected`, (entry as CoverageCase).expected, COVERAGE_RESULT_KEYS); break;
			}
		}
	}
	return found;
}

suite('checkpoint — общие с VibeIDEA векторы из набора', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const vectors: CheckpointVectors = JSON.parse(readFileSync(join(REPO_ROOT, '.vibe-defaults', 'testVectors', 'checkpoint.json'), 'utf8'));

	test('формат вектора знаком: версия и ключи, ни одного незнакомого поля', () => {
		assert.strictEqual(vectors.version, SUPPORTED_VERSION, 'версия формата вектора выросла — прочитать контракт заново');
		assert.deepStrictEqual(unknownFields(vectors), [], 'в векторах есть поля, которых этот тест не знает');
		for (const section of Object.keys(SECTION_KEYS)) {
			assert.ok((vectors as unknown as Record<string, readonly unknown[]>)[section].length > 0, `в разделе ${section} нет ни одного случая`);
		}
	});

	// One truth in the code: the constants are compared with the vector, not copied from it
	test('константы кода равны векторным: порог возраста при уборке и имена командных инструментов', () => {
		assert.deepStrictEqual(
			{ pruneMinAgeMs: SNAPSHOT_PRUNE_MIN_AGE_MS, shellToolNames: [...SHELL_TOOL_NAMES] },
			{ pruneMinAgeMs: vectors.pruneMinAgeMs, shellToolNames: [...vectors.shellToolNames] },
		);
	});

	test('сообщение коммита собирается так же, как в VibeIDEA', () => {
		const actual = vectors.commitMessage.map(({ name, product, tree, meta }) => ({ name, expected: snapshotCommitMessage(tree, meta, product) }));
		assert.deepStrictEqual(actual, vectors.commitMessage.map(({ name, expected }) => ({ name, expected })));
	});

	test('сообщение коммита читается в те же поля, из которых собрано (снимок одного продукта читает другой)', () => {
		const actual = vectors.commitMessage.map(({ name, expected }) => ({ name, fields: parseSnapshotCommitMessage(expected) }));
		const wanted = vectors.commitMessage.map(({ name, tree, meta }) => ({
			name,
			fields: {
				tree,
				...(meta.turnIndex === undefined ? {} : { turnIndex: meta.turnIndex }),
				...(meta.toolName?.trim() ? { toolName: meta.toolName.trim() } : {}),
				...(meta.threadId ? { threadId: meta.threadId } : {}),
				...(meta.agent ? { agent: meta.agent } : {}),
				// A label is cut to one line on writing, so a reader gets the one-line form back
				...(meta.label?.trim() ? { label: meta.label.replace(/\s+/g, ' ').trim() } : {}),
			},
		}));
		assert.deepStrictEqual(actual, wanted);
	});

	test('разбор сообщения: известные поля, прежняя запись, неизвестные ключи пропущены', () => {
		const actual = vectors.parseMessage.map(({ name, message }) => ({ name, fields: parseSnapshotCommitMessage(message) }));
		assert.deepStrictEqual(actual, vectors.parseMessage.map(({ name, expected }) => ({ name, fields: expected })));
	});

	test('разбор вывода for-each-ref', () => {
		const actual = vectors.parsePinned.map(({ name, stdout }) => ({ name, refs: parsePinnedSnapshots(stdout) }));
		assert.deepStrictEqual(actual, vectors.parsePinned.map(({ name, expected }) => ({ name, refs: expected })));
	});

	test('уборка: снимаются только старые и не живые, в порядке входа', () => {
		const actual = vectors.staleRefs.map(({ name, nowMs, pinned, live }) => ({ name, ids: selectStaleSnapshotRefs(pinned, live, nowMs) }));
		assert.deepStrictEqual(actual, vectors.staleRefs.map(({ name, expected }) => ({ name, ids: expected })));
	});

	test('переиспользование предыдущего снимка', () => {
		const actual = vectors.reuse.map(({ name, newTree, previousTree }) => ({ name, reuse: shouldReuseSnapshot(newTree, previousTree) }));
		assert.deepStrictEqual(actual, vectors.reuse.map(({ name, expected }) => ({ name, reuse: expected })));
	});

	test('план отката: игнорируемое не удаляется, списки отсортированы без повторов', () => {
		const actual = vectors.restorePlan.map(({ name, snapshotPaths, workingPaths, ignoredPaths }) => {
			// In the product git lists the folder with the ignored files already left out
			const ignored = new Set(ignoredPaths);
			return { name, plan: planSnapshotRestore(snapshotPaths, workingPaths.filter(path => !ignored.has(path))) };
		});
		assert.deepStrictEqual(actual, vectors.restorePlan.map(({ name, expected }) => ({ name, plan: expected })));
	});

	test('предупреждение о командах после отката', () => {
		const actual = vectors.coverage.map(({ name, hasSnapshot, wouldChangeAnything, toolNames }) => ({ name, coverage: checkpointCoverage({ hasSnapshot, wouldChangeAnything, toolNames }) }));
		assert.deepStrictEqual(actual, vectors.coverage.map(({ name, expected }) => ({ name, coverage: expected })));
	});
});
