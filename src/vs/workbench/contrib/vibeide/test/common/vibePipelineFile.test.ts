/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import {
	buildStepInput,
	composeReviewGoal,
	composeReworkRequest,
	EARLIER_STEP_NOTE_CHARS,
	effectiveWriteScope,
	isModelReference,
	parseModelRef,
	parsePipelineFile,
	parseReviewVerdict,
	pipelineStepLabel,
	PipelineStepOutcome,
	QA_DEFAULT_WRITE_PATHS,
	shouldRunStep,
	stepMayDelete,
	stepMayWrite,
	VibePipelineStep,
} from '../../common/pipeline/vibePipelineFile.js';
import { isSubagentType, roleMayWrite } from '../../common/vibeSubagentService.js';

const parse = (raw: unknown) => parsePipelineFile(raw, { isKnownRole: isSubagentType, roleMayWrite });

const ok = (over: Partial<PipelineStepOutcome> = {}): PipelineStepOutcome => ({
	role: 'coder', step: 1, status: 'success', summary: 'сделал', artifacts: ['src/a.ts'], ...over,
});

suite('vibePipelineFile — parsing', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('a valid file is parsed with optional fields preserved', () => {
		const parsed = parse({
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
		const parsed = parse({
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
			[parse(null), parse([]), parse({ pipelines: {} })].map(p => p.warnings),
			[
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: корень должен быть объектом'],
				['pipelines.json: поле pipelines должно быть массивом'],
			],
		);
	});

	test('the wave label is read trimmed, and an empty one is no label', () => {
		const parsed = parse({
			pipelines: [{
				id: 'w', steps: [
					{ role: 'code-reviewer', task: 'а', wave: ' review ' },
					{ role: 'security', task: 'б', wave: '  ' },
					{ role: 'critic', task: 'в', wave: 7 },
				],
			}],
		});
		assert.deepStrictEqual(parsed.file.pipelines[0].steps.map(s => s.wave), ['review', undefined, undefined]);
	});

	test('more than twenty steps is refused — a runaway file must not spawn a fleet', () => {
		const steps = Array.from({ length: 21 }, () => ({ role: 'coder', task: 'go' }));
		const parsed = parse({ pipelines: [{ id: 'huge', steps }] });
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
		assert.deepStrictEqual(buildStepInput(step, [], 3), { goal: 'проверь работу', contextItems: [] });
	});

	test('earlier steps are told in a line each, the previous one in full, the paths accumulate', () => {
		// Step three must still be able to open what step one created, and must know what step one
		// decided — or it decides again, differently.
		const input = buildStepInput(step, [
			ok({ role: 'architect', summary: 'спроектировал', artifacts: ['docs/plan.md'] }),
			ok({ role: 'coder', summary: 'написал код', artifacts: ['src/a.ts', 'docs/plan.md'] }),
		], 3);
		assert.deepStrictEqual(input, {
			goal: 'проверь работу\n\nХод работы до этого:\n- architect: спроектировал\n\nПредыдущий шаг (coder) сообщил: написал код\n\nФайлы, затронутые предыдущими шагами (прочитайте нужные сами): docs/plan.md, src/a.ts',
			contextItems: ['docs/plan.md', 'src/a.ts'],
		});
	});

	/** A diary is a matter of length: an earlier step gets one line however much it wrote. */
	test('an earlier step is capped to one line, the previous one is not', () => {
		const long = `начало ${'слово '.repeat(200)}`;
		const goal = buildStepInput(step, [ok({ role: 'architect', summary: `${long}\n\nвторой абзац` }), ok({ summary: long })], 3).goal;
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
		], 4).goal;
		assert.strictEqual(goal, [
			'проверь работу',
			'Ход работы до этого:\n- architect: спроектировал [ревью openAI/gpt-5.6: принято]\n- qa (не удался): тесты не запустились',
			'Предыдущий шаг (coder) сообщил: написал код [ревью openAI/gpt-5.6: требовал доработки — шаг переделан один раз, повторно не проверялся]',
			'Файлы, затронутые предыдущими шагами (прочитайте нужные сами): src/a.ts',
		].join('\n\n'));
	});

	/** After a wave the next step hears every step of it — the last one alone is just one of several. */
	test('after a wave every step of it is told whole, each under its own heading', () => {
		const accepted = { by: 'openAI/gpt-6-sol', verdict: 'accepted' as const, notes: 'ок', sawWorkerSummary: false };
		const input = buildStepInput({ role: 'critic', task: 'сведи замечания' }, [
			ok({ role: 'planner', step: 1, summary: 'план в docs/plan.md', artifacts: ['docs/plan.md'] }),
			ok({ role: 'code-reviewer', step: 2, wave: 'review', summary: 'две ошибки в src/a.ts', artifacts: [], review: accepted }),
			ok({ role: 'security', step: 3, wave: 'review', status: 'failed', summary: 'модель не ответила', artifacts: [] }),
		], 4);
		assert.deepStrictEqual(input, {
			goal: [
				'сведи замечания',
				'Ход работы до этого:\n- planner: план в docs/plan.md',
				'Предыдущие шаги шли одновременно, волной «review», — итог каждого под своим заголовком:',
				'Шаг 2/4 · code-reviewer [ревью openAI/gpt-6-sol: принято]\nдве ошибки в src/a.ts',
				'Шаг 3/4 · security · не удался\nмодель не ответила',
				'Файлы, затронутые предыдущими шагами (прочитайте нужные сами): docs/plan.md',
			].join('\n\n'),
			contextItems: ['docs/plan.md'],
		});
	});

	test('a wave followed by another wave hears only the later one in full', () => {
		const goal = buildStepInput({ role: 'critic', task: 'итог' }, [
			ok({ role: 'backend-dev', step: 1, wave: 'build', summary: 'сервер', artifacts: [] }),
			ok({ role: 'frontend-dev', step: 2, wave: 'build', summary: 'интерфейс', artifacts: [] }),
			ok({ role: 'code-reviewer', step: 3, wave: 'review', summary: 'чисто', artifacts: [] }),
			ok({ role: 'security', step: 4, wave: 'review', summary: '', artifacts: [] }),
		], 5).goal;
		assert.strictEqual(goal, [
			'итог',
			'Ход работы до этого:\n- backend-dev: сервер\n- frontend-dev: интерфейс',
			'Предыдущие шаги шли одновременно, волной «review», — итог каждого под своим заголовком:',
			'Шаг 3/5 · code-reviewer\nчисто',
			'Шаг 4/5 · security',
		].join('\n\n'));
	});

	test('a pipeline run is named by its step, its wave and whether it is the review', () => {
		assert.deepStrictEqual(
			[pipelineStepLabel(3, 5, undefined), pipelineStepLabel(2, 4, 'review'), pipelineStepLabel(2, 4, 'review', true)],
			['Шаг 3/5', 'Шаг 2/4 · волна «review»', 'Шаг 2/4 · волна «review» · ревью'],
		);
	});

	test('acceptance criteria ride along with the task', () => {
		assert.strictEqual(
			buildStepInput({ role: 'coder', task: 'почини', acceptance: 'тесты зелёные' }, [], 1).goal,
			'почини\n\nКритерий готовности: тесты зелёные',
		);
	});

	test('a step may ask for fresh eyes and gets no inheritance at all', () => {
		assert.deepStrictEqual(
			buildStepInput({ ...step, ignorePreviousArtifacts: true }, [ok()], 2),
			{ goal: 'проверь работу', contextItems: [] },
		);
	});

	test('nothing produced → no empty section is invented', () => {
		const input = buildStepInput(step, [ok({ summary: '', artifacts: [] }), ok({ summary: '', artifacts: [] })], 3);
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

	const step = (over: Record<string, unknown>) => parse({
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
		const tail = ' Закончите ответ строкой «ВЕРДИКТ: принято» или\n«ВЕРДИКТ: доработать», а перед ней перечислите замечания двумя блоками, не смешивая их:\n'
			+ '«По задаче» — сделано ли то, что просит задача, целиком: не сужена ли она и не заменена ли другим;\n'
			+ '«По качеству» — годится ли код, чтобы строить на нём дальше.\n'
			+ 'Блок без замечаний пометьте словом «нет».';
		assert.deepStrictEqual({
			безПересказа: composeReviewGoal(reviewed, 'сделал, всё проверил', false),
			сПересказом: composeReviewGoal(reviewed, 'сделал, всё проверил', true),
			сДиффом: composeReviewGoal(reviewed, 'сделал, всё проверил', false, true),
		}, {
			безПересказа: `${head}Проверьте по файлам: пересказа исполнителя здесь нет намеренно.${tail}`,
			сПересказом: `${head}Что сделано, со слов исполнителя: сделал, всё проверил\nПроверьте по файлам, а не по пересказу.${tail}`,
			сДиффом: `${head}Что шаг изменил, показывает его дифф в конце задания; файлы можно открыть и целиком.\nПроверьте по файлам: пересказа исполнителя здесь нет намеренно.${tail}`,
		});
	});

	/**
	 * Доработка уходит автору в его же переписку, поэтому задача не повторяется. Причина — раньше
	 * правки: правка от симптома возвращается через другую дверь.
	 */
	test('задание на доработку: замечания, причина до правки, ослабленная проверка — не исправление', () => {
		assert.strictEqual(composeReworkRequest('тест `parses empty` красный'), [
			'Ревьюер вернул шаг на доработку. Его замечания:',
			'тест `parses empty` красный',
			'',
			'По каждому замечанию сначала одной строкой назовите причину, потом исправьте её.',
			'Ослабить или удалить проверку в тесте — не исправление.',
			'Не трогайте то, о чём замечания не говорят.',
		].join('\n'));
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

		/** Папка уносит всё содержимое: её удаление судится по каждому файлу внутри, а не по имени папки */
		test('удаление: файл — как запись, папка — по всему содержимому', () => {
			const impl = step(['src/**'], ['**/secrets/**']);
			assert.deepStrictEqual({
				файл: stepMayDelete(impl, 'src/a.ts', undefined),
				чужойФайл: stepMayDelete(impl, 'docs/a.md', undefined),
				папкаСвоя: stepMayDelete(impl, 'src/old', ['src/old/a.ts', 'src/old/b.ts']),
				папкаССекретом: stepMayDelete(impl, 'src', ['src/a.ts', 'src/secrets/key.pem']),
				запрещённаяПапка: stepMayDelete(impl, 'src/secrets', []),
				пустаяСвоя: stepMayDelete(impl, 'src/empty', []),
				пустаяЧужая: stepMayDelete(impl, 'docs/empty', []),
			}, { файл: true, чужойФайл: false, папкаСвоя: true, папкаССекретом: false, запрещённаяПапка: false, пустаяСвоя: true, пустаяЧужая: false });
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
			const parsed = parse({ version: 1, pipelines: [{ id: 'p', steps: [{ role: 'coder', task: 't', paths: [] }] }] });
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

suite('vibePipelineFile — роли, которые общие с VibeIDEA', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('qa без своих путей пишет только в тесты: тест можно, проверяемый код нельзя', () => {
		const scope = effectiveWriteScope('qa', undefined)!;
		assert.deepStrictEqual(
			[
				stepMayWrite(scope, 'src/order.test.ts'),
				stepMayWrite(scope, 'web/__tests__/button.tsx'),
				stepMayWrite(scope, 'plugins/core/src/OrderTest.kt'),
				stepMayWrite(scope, 'app/test_order.py'),
				stepMayWrite(scope, 'src/order.ts'),
				stepMayWrite(scope, 'plugins/core/src/Order.kt'),
			],
			[true, true, true, true, false, false],
		);
	});

	test('свои paths шага заменяют умолчание, а одни denyPaths его не снимают', () => {
		assert.deepStrictEqual(
			[
				effectiveWriteScope('qa', { paths: ['e2e/**'] }),
				effectiveWriteScope('qa', { denyPaths: ['**/fixtures/**'] }),
			],
			[
				{ paths: ['e2e/**'] },
				{ paths: QA_DEFAULT_WRITE_PATHS, denyPaths: ['**/fixtures/**'] },
			],
		);
	});

	test('умолчание есть только у qa — остальным роли границы не навязываются', () => {
		assert.deepStrictEqual(
			[effectiveWriteScope('backend-dev', undefined), effectiveWriteScope('backend-dev', { denyPaths: ['dist/**'] })],
			[undefined, { denyPaths: ['dist/**'] }],
		);
	});

	test('критик — известная роль: шаг из общего cascade-review больше не падает на её имени', () => {
		assert.deepStrictEqual([isSubagentType('critic'), isSubagentType('criitc')], [true, false]);
	});
});

/**
 * Поля общего с VibeIDEA каскада: шаг `escalation` и модели ролей `roles`.
 *
 * Один и тот же `pipelines.json` читают оба продукта, поэтому опечатка в этих полях роняет пайплайн вслух:
 * молча проигнорированная модель роли или флаг эскалации меняют счёт, а не поведение, и этого никто не заметит.
 */
suite('vibePipelineFile — escalation, roles и логические имена', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const pipeline = (over: Record<string, unknown>, steps: Record<string, unknown>[]) => {
		const parsed = parse({ version: 1, pipelines: [{ id: 'p', ...over, steps }] });
		return { steps: parsed.file.pipelines[0]?.steps, warnings: parsed.warnings };
	};

	test('escalation — только булево: true ставит поле, false — нет, строка роняет пайплайн', () => {
		assert.deepStrictEqual([true, false, 'true'].map(escalation => pipeline({}, [{ role: 'critic', task: 'а', escalation }])), [
			{ steps: [{ role: 'critic', task: 'а', escalation: true }], warnings: [] },
			{ steps: [{ role: 'critic', task: 'а' }], warnings: [] },
			{ steps: undefined, warnings: ['pipelines[0] «p», шаг 1: поле escalation — true или false — пайплайн пропущен'] },
		]);
	});

	test('любой флаг шага строкой роняет пайплайн, а не становится false', () => {
		assert.deepStrictEqual(['continueOnFailure', 'ignorePreviousArtifacts', 'offPeak'].map(flag => pipeline({}, [{ role: 'critic', task: 'а', model: 'zai/glm-5.3', [flag]: 'true' }]).warnings), [
			['pipelines[0] «p», шаг 1: поле continueOnFailure — true или false — пайплайн пропущен'],
			['pipelines[0] «p», шаг 1: поле ignorePreviousArtifacts — true или false — пайплайн пропущен'],
			['pipelines[0] «p», шаг 1: поле offPeak — true или false — пайплайн пропущен'],
		]);
	});

	test('roles: шаг без своей модели берёт модель роли, своя сильнее, пара provider + model — синоним', () => {
		const parsed = pipeline({ roles: { 'code-reviewer': { model: ' minimax/MiniMax-M3 ' }, critic: { provider: 'anthropic', model: 'claude-fable-5-1' } } }, [
			{ role: 'code-reviewer', task: 'а' },
			{ role: 'code-reviewer', task: 'б', model: 'zai/glm-5.3-flash' },
			{ role: 'critic', task: 'в', escalation: true },
			{ role: 'planner', task: 'г' },
		]);
		assert.deepStrictEqual({ models: parsed.steps?.map(step => step.model), warnings: parsed.warnings }, {
			models: ['minimax/MiniMax-M3', 'zai/glm-5.3-flash', 'anthropic/claude-fable-5-1', undefined],
			warnings: [],
		});
	});

	test('roles: неизвестная роль и неполный адрес пропускают пайплайн, roles не объектом — игнорируется вслух', () => {
		const tried = [
			{ critc: { model: 'anthropic/claude-fable-5-1' } },
			{ critic: { provider: 'anthropic' } },
			{ critic: { model: 'claude-fable-5-1' } },
			{ critic: 'anthropic/claude-fable-5-1' },
			['critic'],
		].map(roles => pipeline({ roles }, [{ role: 'critic', task: 'а' }]));
		const halfAddress = 'pipelines[0] «p»: roles.critic: нужна модель «провайдер/модель» — полем model одной строкой или парой provider + model — пайплайн пропущен';
		assert.deepStrictEqual(tried, [
			{ steps: undefined, warnings: ['pipelines[0] «p»: roles: неизвестная роль «critc» — пайплайн пропущен'] },
			{ steps: undefined, warnings: [halfAddress] },
			{ steps: undefined, warnings: [halfAddress] },
			{ steps: undefined, warnings: [halfAddress] },
			{ steps: [{ role: 'critic', task: 'а' }], warnings: ['pipelines[0] «p»: поле roles должно быть объектом «роль → { "model": "провайдер/модель" }» — проигнорировано'] },
		]);
	});

	test('roles: модель пишущей роли принимается, но с предупреждением, что VibeIDEA пайплайн пропустит', () => {
		assert.deepStrictEqual(pipeline({ roles: { 'backend-dev': { model: 'openai/gpt-6-luna' } } }, [{ role: 'backend-dev', task: 'а' }]), {
			steps: [{ role: 'backend-dev', task: 'а', model: 'openai/gpt-6-luna' }],
			warnings: ['pipelines[0] «p»: roles.backend-dev: модель у пишущей роли — VibeIDE её примет, VibeIDEA этот пайплайн пропустит'],
		});
	});

	test('offPeak требует собственной модели шага — модель из roles не считается', () => {
		assert.deepStrictEqual(pipeline({ roles: { planner: { model: 'deepseek/deepseek-flash' } } }, [{ role: 'planner', task: 'а', offPeak: true }]), {
			steps: undefined,
			warnings: ['pipelines[0] «p», шаг 1: поле offPeak требует model «провайдер/модель» — расписание цены есть только у модели — пайплайн пропущен'],
		});
	});

	test('логическое имя @fast годится везде, где ждут модель, а parseModelRef по-прежнему не гадает', () => {
		assert.deepStrictEqual({
			parsed: pipeline({ roles: { critic: { model: '@smart' } } }, [
				{ role: 'backend-dev', task: 'а', model: '@fast', escalateTo: '@smart', reviewWith: ' @review ', offPeak: true },
				{ role: 'critic', task: 'б' },
			]),
			references: ['@fast', 'zai/glm', '@', 'glm', 7].map(isModelReference),
			bare: parseModelRef('@fast'),
		}, {
			parsed: {
				steps: [
					{ role: 'backend-dev', task: 'а', model: '@fast', escalateTo: '@smart', reviewWith: '@review', offPeak: true },
					{ role: 'critic', task: 'б', model: '@smart' },
				],
				warnings: [],
			},
			references: [true, true, false, false, false],
			bare: undefined,
		});
	});
});
