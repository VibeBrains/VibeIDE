/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { applyWaveRules, checkWaves, literalPrefix, pipelineGroups, provablyDisjoint, WaveRules } from '../../common/pipeline/pipelineWaves.js';
import { parsePipelineFile, QA_DEFAULT_WRITE_PATHS, VibePipelineStep } from '../../common/pipeline/vibePipelineFile.js';
import { roleMayWrite } from '../../common/vibeSubagentService.js';

/**
 * Waves: which steps run at once, and every reason two of them must not.
 *
 * The cases follow VibeIDEA's `PipelineWavesTest.kt` one for one where the rule is shared: the same
 * `pipelines.json` must load in both products or in neither.
 */
suite('pipelineWaves', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const rules: WaveRules = { roleMayWrite, qaWritePaths: QA_DEFAULT_WRITE_PATHS };
	const step = (role: string, wave?: string, paths?: string[], extra: Partial<VibePipelineStep> = {}): VibePipelineStep => ({
		role, task: 't', ...(wave ? { wave } : {}), ...(paths ? { paths } : {}), ...extra,
	});

	test('a wave is a run of neighbours with one label, a plain step and a lone label are runs of one', () => {
		assert.deepStrictEqual(pipelineGroups([
			step('backend-dev', 'w1'), step('frontend-dev', 'w1'), step('qa'), step('critic', 'alone'),
			step('code-reviewer', 'w2'), step('security', 'w2'), step('critic', 'w2'),
		]), [
			{ start: 0, end: 1, wave: 'w1' },
			{ start: 2, end: 2 },
			{ start: 3, end: 3 },
			{ start: 4, end: 6, wave: 'w2' },
		]);
	});

	test('writers in separate directories may run at once', () => {
		const check = checkWaves([step('backend-dev', 'build', ['server/**']), step('frontend-dev', 'build', ['web/src/**', 'web/public/'])], rules);
		assert.deepStrictEqual(check, { problems: [], warnings: [] });
	});

	test('writers whose places nest are refused, and the refusal names both', () => {
		const check = checkWaves([step('backend-dev', 'build', ['src/**']), step('frontend-dev', 'build', ['src/ui/**'])], rules);
		assert.deepStrictEqual(check.problems, ['волна «build»: «backend-dev» (src/**) и «frontend-dev» (src/ui/**) могут писать в одно место — дайте каждому paths с раздельными каталогами в начале']);
	});

	test('a writer without paths writes anywhere and cannot share a wave with another writer', () => {
		assert.strictEqual(checkWaves([step('backend-dev', 'build'), step('frontend-dev', 'build', ['web/**'])], rules).problems.length, 1);
	});

	test('a pattern without a leading directory proves nothing', () => {
		assert.strictEqual(checkWaves([step('designer', 'docs', ['*.md']), step('backend-dev', 'docs', ['server/**'])], rules).problems.length, 1);
	});

	test('qa without its own paths writes tests everywhere, so it cannot run beside a writer', () => {
		assert.strictEqual(checkWaves([step('qa', 'w'), step('backend-dev', 'w', ['server/**'])], rules).problems.length, 1);
	});

	test('judges never overlap', () => {
		assert.deepStrictEqual(checkWaves([step('code-reviewer', 'review'), step('security', 'review'), step('critic', 'review')], rules), { problems: [], warnings: [] });
	});

	test('a judge beside a writer is allowed but said out loud', () => {
		const check = checkWaves([step('backend-dev', 'w', ['server/**']), step('code-reviewer', 'w')], rules);
		assert.deepStrictEqual(check, {
			problems: [],
			warnings: ['волна «w»: «code-reviewer» идёт одновременно с «backend-dev» и увидит его работу недоделанной — ревью лучше ставить следующей волной'],
		});
	});

	test('offPeak cannot be part of a wave; the cascade on the step itself can', () => {
		const offPeak = checkWaves([step('code-reviewer', 'w'), step('critic', 'w', undefined, { model: 'zai/glm-5.3', offPeak: true })], rules);
		const cascade = checkWaves([step('code-reviewer', 'w', undefined, { model: 'zai/glm-5.3', escalateTo: 'anthropic/claude-opus-5-5', reviewWith: 'openAI/gpt-6-sol' }), step('security', 'w')], rules);
		assert.deepStrictEqual({ offPeak: offPeak.problems.length, cascade: cascade.problems.length }, { offPeak: 1, cascade: 0 });
	});

	test('a label that comes back after another step is refused', () => {
		const check = checkWaves([step('code-reviewer', 'w'), step('security', 'w'), step('planner'), step('critic', 'w'), step('explore', 'w')], rules);
		assert.deepStrictEqual(check.problems, ['волна «w»: шаги с одной меткой должны идти подряд, а метка вернулась после другого шага']);
	});

	test('a wave of one step runs as an ordinary step, with a word about it', () => {
		assert.deepStrictEqual(checkWaves([step('backend-dev', 'alone'), step('qa')], rules), { problems: [], warnings: ['волна «alone» из одного шага — он идёт как обычный'] });
	});

	test('an unknown role counts as writing — nobody can prove it harmless', () => {
		assert.strictEqual(checkWaves([step('coder', 'w'), step('backend-dev', 'w', ['server/**'])], rules).problems.length, 1);
	});

	/**
	 * Our matcher is `.gitignore` proper: one trailing slash is dropped, and only a slash at the start or
	 * inside anchors a pattern. So `docs/` is a `docs` folder at any depth here — VibeIDEA anchors it.
	 */
	test('the proof reads patterns the way the write check matches them', () => {
		assert.deepStrictEqual({
			folderAnyDepth: literalPrefix('docs/'),
			nested: literalPrefix('web/public/'),
			rooted: literalPrefix('/Server/**'),
			file: literalPrefix('src/app.ts'),
			wildcardFirst: literalPrefix('**/test/**'),
			bareName: literalPrefix('README.md'),
			dotSegment: literalPrefix('./src/**'),
			wildcardInside: literalPrefix('src/*/gen/**'),
		}, {
			folderAnyDepth: undefined,
			nested: ['web', 'public'],
			rooted: ['server'],
			file: ['src', 'app.ts'],
			wildcardFirst: undefined,
			bareName: undefined,
			dotSegment: undefined,
			wildcardInside: ['src'],
		});
	});

	test('directories are compared with case folded, and negations and denies only narrow', () => {
		assert.deepStrictEqual({
			caseFolded: provablyDisjoint({ paths: ['Src/**'] }, { paths: ['src/lib/**'] }),
			fileBesideFolder: provablyDisjoint({ paths: ['src/app.ts'] }, { paths: ['src/lib/**'] }),
			negationIgnored: provablyDisjoint({ paths: ['server/**', '!server/gen/**'] }, { paths: ['web/**'] }),
			denyIgnored: provablyDisjoint({ paths: ['src/**'], denyPaths: ['src/ui/**'] }, { paths: ['src/ui/**'] }),
			noScope: provablyDisjoint(undefined, { paths: ['web/**'] }),
		}, {
			caseFolded: false,
			fileBesideFolder: true,
			negationIgnored: true,
			denyIgnored: false,
			noScope: false,
		});
	});

	test('a pipeline whose wave cannot run is skipped with the reason, the rest load with their warnings', () => {
		const parsed = applyWaveRules(parsePipelineFile({
			pipelines: [
				{ id: 'bad', steps: [{ role: 'backend-dev', task: 'а', wave: 'w' }, { role: 'frontend-dev', task: 'б', wave: 'w' }] },
				{ id: 'lone', steps: [{ role: 'planner', task: 'в', wave: 'x' }] },
				{ id: 'good', steps: [{ role: 'planner', task: 'г' }] },
			],
		}), rules);
		assert.deepStrictEqual({ ids: parsed.file.pipelines.map(p => p.id), warnings: parsed.warnings }, {
			ids: ['lone', 'good'],
			warnings: [
				'«bad»: волна «w»: «backend-dev» (**) и «frontend-dev» (**) могут писать в одно место — дайте каждому paths с раздельными каталогами в начале — пайплайн пропущен',
				'«lone»: волна «x» из одного шага — он идёт как обычный',
			],
		});
	});
});
