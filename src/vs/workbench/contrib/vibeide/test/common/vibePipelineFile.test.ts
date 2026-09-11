/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildStepInput,
	composeReviewGoal,
	EARLIER_STEP_NOTE_CHARS,
	parseModelRef,
	parsePipelineFile,
	parseReviewVerdict,
	PipelineStepOutcome,
	shouldRunStep,
	stepMayWrite,
	VibePipelineStep,
} from '../../common/pipeline/vibePipelineFile.js';

const ok = (over: Partial<PipelineStepOutcome> = {}): PipelineStepOutcome => ({
	role: 'coder', status: 'success', summary: 'сделал', artifacts: ['src/a.ts'], ...over,
});

suite('vibePipelineFile — parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid file is parsed with optional fields preserved', () => {
		const parsed = parsePipelineFile({
			version: 1,
			pipelines: [{
				id: 'review', name: 'Ревью', steps: [
					{ role: 'coder', task: '  почини тесты  ', acceptance: 'тесты зелёные', maxTokens: 5000.7, maxSteps: 12, continueOnFailure: true },
					{ role: 'reviewer', task: 'проверь', ignorePreviousArtifacts: true },
				],
			}],
		});
		assert.deepStrictEqual(parsed, {
			warnings: [],
			file: {
				version: 1,
				pipelines: [{
					id: 'review', name: 'Ревью', steps: [
						{ role: 'coder', task: 'почини тесты', acceptance: 'тесты зелёные', maxTokens: 5000, maxSteps: 12, continueOnFailure: true },
						{ role: 'reviewer', task: 'проверь', ignorePreviousArtifacts: true },
					],
				}],
			},
		});
	});

	test('one broken pipeline is skipped, the good ones survive', () => {
		// The whole file failing over a single typo is what makes people stop using config files.
		const parsed = parsePipelineFile({
			pipelines: [
				{ id: 'good', steps: [{ role: 'coder', task: 'делай' }] },
				{ steps: [{ role: 'coder', task: 'без id' }] },
				{ id: 'empty', steps: [] },
				{ id: 'badstep', steps: [{ role: 'coder' }] },
				{ id: 'good', steps: [{ role: 'coder', task: 'дубль' }] },
			],
		});
		assert.deepStrictEqual(
			{ ids: parsed.file.pipelines.map(p => p.id), warnings: parsed.warnings },
			{
				ids: ['good'],
				warnings: [
					'pipelines[1]: нет поля id — пропущен',
					'pipelines[2] «empty»: нужен непустой массив steps — пропущен',
					'pipelines[3] «badstep», шаг 1: нет поля task — пайплайн пропущен',
					'pipelines[4]: id «good» уже занят — пропущен',
				],
			},
		);
	});

	test('a non-object root and a non-array pipelines field are reported, not thrown', () => {
		assert.deepStrictEqual(
			[parsePipelineFile(null), parsePipelineFile([]), parsePipelineFile({ pipelines: {} })].map(p => p.warnings),
			[
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: поле pipelines должно быть массивом'],
			],
		);
	});

	test('more than twenty steps is refused — a runaway file must not spawn a fleet', () => {
		const steps = Array.from({ length: 21 }, () => ({ role: 'coder', task: 'go' }));
		const parsed = parsePipelineFile({ pipelines: [{ id: 'huge', steps }] });
		assert.deepStrictEqual(
			{ count: parsed.file.pipelines.length, warning: parsed.warnings[0] },
			{ count: 0, warning: 'pipelines[0] «huge»: больше 20 шагов — пропущен' },
		);
	});
});

suite('vibePipelineFile — handing work to the next step', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const step: VibePipelineStep = { role: 'reviewer', task: 'проверь работу' };

	test('the first step gets its task and nothing else', () => {
		assert.deepStrictEqual(buildStepInput(step, []), { goal: 'проверь работу', contextItems: [] });
	});

	test('earlier steps are told in a line each, the previous one in full, the paths accumulate', () => {
		// Step three must still be able to open what step one created, and must know what step one
		// decided — or it decides again, differently.
		const input = buildStepInput(step, [
			ok({ role: 'architect', summary: 'спроектировал', artifacts: ['docs/plan.md'] }),
			ok({ role: 'coder', summary: 'написал код', artifacts: ['src/a.ts', 'docs/plan.md'] }),
		]);
		assert.deepStrictEqual(input, {
			goal: 'проверь работу\n\nХод работы до этого:\n- architect: спроектировал\n\nПредыдущий шаг (coder) сообщил: написал код\n\nФайлы, затронутые предыдущими шагами (прочитайте нужные сами): docs/plan.md, src/a.ts',
			contextItems: ['docs/plan.md', 'src/a.ts'],
		});
	});

	/** A diary is a matter of length: an earlier step gets one line however much it wrote. */
	test('an earlier step is capped to one line, the previous one is not', () => {
		const long = `начало ${'слово '.repeat(200)}`;
		const goal = buildStepInput(step, [ok({ role: 'architect', summary: `${long}\n\nвторой абзац` }), ok({ summary: long })]).goal;
		const earlierLine = goal.split('\n').find(line => line.startsWith('- architect: ')) ?? '';
		assert.deepStrictEqual({
			earlierLength: earlierLine.length,
			earlierEndsWithEllipsis: earlierLine.endsWith('…'),
			previousInFull: goal.includes(`сообщил: ${long}`),
		}, {
			earlierLength: '- architect: '.length + EARLIER_STEP_NOTE_CHARS,
			earlierEndsWithEllipsis: true,
			previousInFull: true,
		});
	});

	/** Without the verdicts a later step cannot tell a settled decision from a disputed one. */
	test('how each step ended and what its reviewer said travel along', () => {
		const accepted = { by: 'openAI/gpt-5.6', verdict: 'accepted' as const, notes: 'ок', sawWorkerSummary: false };
		const goal = buildStepInput({ ...step, continueOnFailure: true }, [
			ok({ role: 'architect', summary: 'спроектировал', review: accepted }),
			ok({ role: 'qa', status: 'failed', summary: 'тесты не запустились' }),
			ok({ role: 'coder', summary: 'написал код', artifacts: [], review: { ...accepted, verdict: 'rework' } }),
		]).goal;
		assert.strictEqual(goal, [
			'проверь работу',
			'Ход работы до этого:\n- architect: спроектировал [ревью openAI/gpt-5.6: принято]\n- qa (не удался): тесты не запустились',
			'Предыдущий шаг (coder) сообщил: написал код [ревью openAI/gpt-5.6: требовал доработки — шаг переделан один раз, повторно не проверялся]',
			'Файлы, затронутые предыдущими шагами (прочитайте нужные сами): src/a.ts',
		].join('\n\n'));
	});

	test('acceptance criteria ride along with the task', () => {
		assert.strictEqual(
			buildStepInput({ role: 'coder', task: 'почини', acceptance: 'тесты зелёные' }, []).goal,
			'почини\n\nКритерий готовности: тесты зелёные',
		);
	});

	test('a step may ask for fresh eyes and gets no inheritance at all', () => {
		assert.deepStrictEqual(
			buildStepInput({ ...step, ignorePreviousArtifacts: true }, [ok()]),
			{ goal: 'проверь работу', contextItems: [] },
		);
	});

	test('nothing produced → no empty section is invented', () => {
		const input = buildStepInput(step, [ok({ summary: '', artifacts: [] }), ok({ summary: '', artifacts: [] })]);
		assert.deepStrictEqual(input, { goal: 'проверь работу', contextItems: [] });
	});

	test('a failure stops the line unless the step opted out', () => {
		const failed = [ok({ status: 'failed' })];
		assert.deepStrictEqual(
			[shouldRunStep(step, []), shouldRunStep(step, [ok()]), shouldRunStep(step, failed), shouldRunStep({ ...step, continueOnFailure: true }, failed)],
			[true, true, false, true],
		);
	});
});

/**
 * Каскад и критика — два паттерна из HydraFusion, перенесённые на наш стек.
 *
 * Обе ставки денежные: эскалация оплачивается сверх черновика, а ревью — это лишний прогон модели.
 * Поэтому в разборе они обязаны быть однозначными: ссылка на модель без провайдера — ошибка шага,
 * а вердикт ревьюера, которого нет, — «не распознан», а не «принято».
 */
suite('vibePipelineFile — каскад и критика', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const step = (over: Record<string, unknown>) => parsePipelineFile({
		version: 1,
		pipelines: [{ id: 'p', steps: [{ role: 'coder', task: 'сделай', ...over }] }],
	});

	test('модель, эскалация и ревьюер разбираются как «провайдер/модель»', () => {
		const parsed = step({ model: ' zai/glm-5.3-flash ', escalateTo: 'anthropic/claude-opus-5', reviewWith: 'openAI/gpt-5.6' });
		assert.deepStrictEqual(parsed.file.pipelines[0].steps[0], {
			role: 'coder', task: 'сделай',
			model: 'zai/glm-5.3-flash', escalateTo: 'anthropic/claude-opus-5', reviewWith: 'openAI/gpt-5.6',
		});
	});

	/**
	 * Одна и та же модель живёт у нескольких провайдеров по разным ценам, поэтому голое имя —
	 * ошибка шага, а не поле, которое молча отбросили: иначе дешёвый черновик тихо поедет на модели
	 * роли, и весь смысл каскада исчезнет, не сообщив об этом.
	 */
	test('ссылка без провайдера роняет шаг с внятной причиной', () => {
		const parsed = step({ model: 'glm-5.3-flash' });
		assert.deepStrictEqual(
			[parsed.file.pipelines.length, parsed.warnings.some(w => w.includes('провайдер/модель'))],
			[0, true],
		);
	});

	test('parseModelRef отделяет провайдера от модели и не гадает', () => {
		assert.deepStrictEqual(parseModelRef('zai/glm-5.3-flash'), { providerName: 'zai', modelName: 'glm-5.3-flash' });
		assert.deepStrictEqual(
			[parseModelRef('glm'), parseModelRef('/glm'), parseModelRef('zai/'), parseModelRef(undefined)],
			[undefined, undefined, undefined, undefined],
		);
	});

	/**
	 * Ревьюер проверяет файлы, а не рассказ о них: пересказ «сделал, всё проверил» — это история
	 * разработки, и, прочитав её первой, ревьюер проверяет утверждение, а не работу.
	 */
	test('ревьюер получает задачу и критерий, а пересказ исполнителя — только по настройке', () => {
		const reviewed = { role: 'coder', task: 'добавь эндпоинт', acceptance: 'тесты зелёные' };
		const head = 'Проверьте результат шага «coder».\nЗадача шага: добавь эндпоинт\nКритерий готовности: тесты зелёные\n';
		const tail = ' Закончите ответ строкой «ВЕРДИКТ: принято» или\n«ВЕРДИКТ: доработать», а перед ней перечислите замечания, если они есть.';
		assert.deepStrictEqual({
			безПересказа: composeReviewGoal(reviewed, 'сделал, всё проверил', false),
			сПересказом: composeReviewGoal(reviewed, 'сделал, всё проверил', true),
		}, {
			безПересказа: `${head}Проверьте по файлам: пересказа исполнителя здесь нет намеренно.${tail}`,
			сПересказом: `${head}Что сделано, со слов исполнителя: сделал, всё проверил\nПроверьте по файлам, а не по пересказу.${tail}`,
		});
	});

	/** Вердикт нужен машине: проза «в целом неплохо, но…» — это принято или доработать? */
	test('вердикт ревьюера читается по последнему упоминанию, иначе — «не распознан»', () => {
		assert.strictEqual(parseReviewVerdict('Всё хорошо.\nВЕРДИКТ: принято'), 'accepted');
		assert.strictEqual(parseReviewVerdict('Есть замечания.\nвердикт: доработать'), 'rework');
		// Ревьюер процитировал инструкцию, а потом ответил — читаем ответ, а не инструкцию.
		assert.strictEqual(parseReviewVerdict('Ответьте «ВЕРДИКТ: принято» или «ВЕРДИКТ: доработать».\nВЕРДИКТ: доработать'), 'rework');
		assert.strictEqual(parseReviewVerdict('Выглядит нормально, но я бы переделал'), 'unclear');
		assert.strictEqual(parseReviewVerdict(undefined), 'unclear');
	});

	suite('права шага на пути', () => {
		const step = (paths?: string[], denyPaths?: string[]) => ({ paths, denyPaths });

		/** Нет полей — ограничения нет вовсе: шаг пишет куда угодно, как раньше. */
		test('без полей ограничения нет', () => {
			assert.deepStrictEqual({
				вИсходники: stepMayWrite(step(), 'src/a.ts'),
				вДоки: stepMayWrite(step(), 'docs/b.md'),
			}, { вИсходники: true, вДоки: true });
		});

		/** Ради чего всё: роль «документация» не переписывает исходники соседнего шага. */
		test('разрешение сужает, и всё остальное закрыто', () => {
			const docs = step(['docs/**', '*.md']);
			assert.deepStrictEqual({
				своя: stepMayWrite(docs, 'docs/guide.md'),
				// Шаблон без слэша по правилу .gitignore ловит любой уровень.
				вКорне: stepMayWrite(docs, 'README.md'),
				глубоко: stepMayWrite(docs, 'src/nested/notes.md'),
				чужая: stepMayWrite(docs, 'src/index.ts'),
			}, { своя: true, вКорне: true, глубоко: true, чужая: false });
		});

		/** Запрет проверяется первым и сильнее разрешения — иначе «src/**» открыл бы и секреты. */
		test('запрет сильнее разрешения', () => {
			const impl = step(['src/**'], ['**/secrets/**']);
			assert.deepStrictEqual({
				обычный: stepMayWrite(impl, 'src/app/main.ts'),
				секрет: stepMayWrite(impl, 'src/secrets/key.ts'),
			}, { обычный: true, секрет: false });
		});

		/**
		 * Порядок записей внутри списка не меняет ответ.
		 *
		 * Здесь мы намеренно расходимся с gitignore, где побеждает последнее совпадение: файл,
		 * строки которого кто-то отсортировал, не должен менять то, что агенту можно писать.
		 */
		test('порядок записей ничего не решает', () => {
			const прямой = stepMayWrite(step(['src/**', 'docs/**'], ['**/secrets/**']), 'src/secrets/k.ts');
			const обратный = stepMayWrite(step(['docs/**', 'src/**'], ['**/secrets/**']), 'src/secrets/k.ts');
			assert.deepStrictEqual({ прямой, обратный }, { прямой: false, обратный: false });
		});

		test('пустой список — это отсутствие ограничения, а не запрет всего', () => {
			const parsed = parsePipelineFile({ version: 1, pipelines: [{ id: 'p', steps: [{ role: 'coder', task: 't', paths: [] }] }] });
			assert.strictEqual(parsed.file.pipelines[0]?.steps[0]?.paths, undefined);
			assert.strictEqual(stepMayWrite(parsed.file.pipelines[0].steps[0], 'anything.ts'), true);
		});

		/** Абсолютный путь не угадываем: матчер, отвечающий «можно» на непонятое, опаснее отказа. */
		test('пустой путь закрыт', () => {
			assert.strictEqual(stepMayWrite(step(['src/**']), ''), false);
		});

		/** Запрет сворачивает регистр там, где его сворачивает файловая система; разрешение — никогда. */
		test('запрет не обходится регистром, разрешение точное', () => {
			const impl = step(['src/**'], ['**/secrets/**']);
			assert.deepStrictEqual({
				секретДругимРегистром: stepMayWrite(impl, 'src/Secrets/key.ts', true),
				разрешениеДругимРегистром: stepMayWrite(impl, 'SRC/app.ts', true),
			}, { секретДругимРегистром: false, разрешениеДругимРегистром: false });
		});
	});
});
