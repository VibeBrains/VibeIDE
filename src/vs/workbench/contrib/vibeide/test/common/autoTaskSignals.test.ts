/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { Event } from '../../../../../base/common/event.js';
import { DisposableStore } from '../../../../../base/common/lifecycle.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { InMemoryStorageService } from '../../../../../platform/storage/common/storage.js';
import { buildAutoTaskContext } from '../../common/autoTaskSignals.js';
import { TaskAwareModelRouter } from '../../common/modelRouter.js';
import { IVibeideSettingsService, VibeideSettingsState } from '../../common/vibeideSettingsService.js';
import { defaultGlobalSettings, defaultSettingsOfProvider } from '../../common/vibeideSettingsTypes.js';
import { vibeLog } from '../../common/vibeLog.js';

/** What «Авто» reads out of a message: the task type, the flags that are set, a question about the codebase */
function signalsOf(message: string) {
	const { context, isCodebaseQuestion } = buildAutoTaskContext(message, { hasImages: false, hasPDFs: false });
	const flags = Object.entries(context).filter(([key, value]) => value === true && key !== 'preferLowCost').map(([key]) => key).sort();
	return { taskType: context.taskType, flags, isCodebaseQuestion, contextSize: context.contextSize };
}

/** The same without the context estimate, which follows the length of the message and not its wording */
function wordingSignalsOf(message: string) {
	const { taskType, flags, isCodebaseQuestion } = signalsOf(message);
	return { taskType, flags, isCodebaseQuestion };
}

/**
 * Что «Авто» читает из сообщения, пока выбирает модель: тип задачи и признаки, по которым роутер взвешивает
 * Таблицы слов есть на английском и на русском для каждого признака
 * Одна и та же просьба на любом языке читается одинаково
 */
suite('признаки задачи из сообщения: английский не изменился, русский читается так же', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	/**
	 * Английские сообщения и то, что из них прочёл прежний разбор в `chatThreadService`: снято с него до переноса
	 * Среди них странности, которые перенос сохранил как есть
	 * `project` в любом месте — вопрос о кодовой базе, `function X` в прозе — код
	 */
	const englishAsBefore: ReadonlyArray<readonly [string, string, readonly string[], number | undefined, boolean]> = [
		['hello', 'chat', ['preferLowLatency'], undefined, false],
		['thanks a lot', 'chat', ['preferLowLatency'], undefined, false],
		['What is a closure in JavaScript?', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['how do I reverse a string in python', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['explain recursion', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['tell me about the weather', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['why is the sky blue', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['can you help me with something', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['Implement a login form with validation', 'code', [], undefined, false],
		['create a function that parses dates', 'code', ['hasCode'], undefined, false],
		['add a button to the toolbar', 'code', [], undefined, false],
		['make it faster', 'code', ['isPerformanceTask'], undefined, false],
		['write code to sort an array', 'code', [], undefined, false],
		['fix bug in the parser', 'code', ['isDebuggingTask'], undefined, false],
		['why is this failing: TypeError undefined is not a function', 'chat', ['isDebuggingTask', 'preferLowLatency'], undefined, false],
		['I get an error message when I run npm install', 'chat', ['isDebuggingTask', 'preferLowLatency'], undefined, false],
		['the app crashes on startup', 'chat', ['isDebuggingTask', 'preferLowLatency'], undefined, false],
		['not working at all', 'chat', ['isDebuggingTask', 'preferLowLatency'], undefined, false],
		['stack trace attached, please help', 'chat', ['isDebuggingTask', 'preferLowLatency'], undefined, false],
		['review my code', 'chat', ['isCodeReviewTask', 'preferLowLatency'], undefined, false],
		['refactor this function to be cleaner', 'chat', ['hasCode', 'isCodeReviewTask', 'preferLowLatency'], undefined, false],
		['how can I improve this class', 'chat', ['isCodeReviewTask', 'isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['is this good code?', 'chat', ['isCodeReviewTask', 'preferLowLatency'], undefined, false],
		['suggest improvements for the module', 'chat', ['isCodeReviewTask', 'preferLowLatency'], undefined, false],
		['write unit tests for the cart service', 'chat', ['isTestingTask', 'preferLowLatency'], undefined, false],
		['add tests for the reducer', 'code', ['isTestingTask'], undefined, false],
		['how to test async functions', 'chat', ['isSimpleQuestion', 'isTestingTask', 'preferLowLatency'], undefined, false],
		['document this function', 'chat', ['isDocumentationTask', 'preferLowLatency'], undefined, false],
		['add comments to the file', 'code', ['isDocumentationTask'], undefined, false],
		['write a readme for the project', 'code', ['isDocumentationTask', 'requiresComplexReasoning'], 20000, true],
		['optimize this query', 'chat', ['isCodeReviewTask', 'isPerformanceTask', 'preferLowLatency'], undefined, false],
		['this page is slow, how to speed up rendering', 'chat', ['isPerformanceTask', 'preferLowLatency'], undefined, false],
		['performance issue in the list view', 'chat', ['isDebuggingTask', 'isPerformanceTask', 'preferLowLatency'], undefined, false],
		['is this secure? it stores passwords in plain text', 'chat', ['isSecurityTask', 'preferLowLatency'], undefined, false],
		['check for sql injection and xss', 'chat', ['isSecurityTask', 'preferLowLatency'], undefined, false],
		['authentication flow review', 'chat', ['isCodeReviewTask', 'isMultiStepTask', 'isSecurityTask'], undefined, false],
		['calculate the compound interest', 'chat', ['isMathTask', 'preferLowLatency'], undefined, false],
		['solve this equation: x^2 = 4', 'chat', ['isMathTask', 'preferLowLatency'], undefined, false],
		['translate code from python to rust', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], undefined, false],
		['convert to typescript', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], undefined, false],
		['port to go', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], undefined, false],
		['rewrite in kotlin', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], undefined, false],
		['first create the table, then add the endpoint, and also write tests', 'chat', ['isMultiStepTask', 'isTestingTask'], undefined, false],
		['build the api and the ui and the docs', 'code', ['isDocumentationTask', 'isMultiStepTask'], undefined, false],
		['update the config and modify the schema', 'chat', ['isMultiStepTask'], undefined, false],
		['what is the architecture of this project', 'code', ['requiresComplexReasoning'], 20000, true],
		['summarize my codebase', 'code', ['requiresComplexReasoning'], 20000, true],
		['how many endpoints does the api have', 'code', ['requiresComplexReasoning'], 20000, true],
		['what does this app do', 'code', ['isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], 20000, true],
		['which framework does this project use', 'code', ['requiresComplexReasoning'], 20000, true],
		['explain why the algorithm is correct', 'chat', ['isMathTask', 'isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], 8000, false],
		['analyze the trade-offs and compare and contrast the options', 'chat', ['isMultiStepTask', 'requiresComplexReasoning'], 8000, false],
		['a detailed analysis of the thesis and its hypothesis', 'chat', ['requiresComplexReasoning'], 8000, false],
		['give me a comprehensive and thorough overview', 'chat', ['requiresComplexReasoning'], 8000, false],
		['search the web for the latest node release', 'web_search', [], undefined, false],
		['google it', 'web_search', [], undefined, false],
		['Here is code:\n```js\nconst a = 1;\n```\nwhy does it print undefined?', 'code', ['hasCode'], undefined, false],
		['const x = foo(); what is wrong with this', 'chat', ['hasCode', 'preferLowLatency'], undefined, false],
		['where is the config file', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['who wrote this', 'chat', ['isSimpleQuestion', 'preferLowLatency'], undefined, false],
		['The quick brown fox jumps over the lazy dog', 'chat', ['preferLowLatency'], undefined, false],
		['x'.repeat(520), 'chat', ['isLongMessage'], 8000, false],
		['please explain the project structure and the architecture of the repo in detail so that I can understand how everything fits together and what each folder is responsible for and then also list the main modules', 'code', ['isMultiStepTask', 'requiresComplexReasoning'], 20000, true],
	];

	test('английские сообщения читаются так же, как до переноса в чистый модуль', () => {
		assert.deepStrictEqual(
			englishAsBefore.map(([message]) => signalsOf(message)),
			englishAsBefore.map(([, taskType, flags, contextSize, isCodebaseQuestion]) => ({ taskType, flags, isCodebaseQuestion, contextSize })),
		);
	});

	/**
	 * Русский запрос и его английская пара дают один тип задачи и один набор признаков
	 * Ожидаемое записано, чтобы пара не совпала на пустом месте
	 */
	const pairs: ReadonlyArray<readonly [string, string, string, readonly string[], boolean]> = [
		['Привет', 'hello', 'chat', ['preferLowLatency'], false],
		['Исправь ошибку: приложение падает при запуске', 'fix error: the app crashes on startup', 'chat', ['isDebuggingTask', 'preferLowLatency'], false],
		['Почему не работает эта функция?', 'why is this failing', 'chat', ['isDebuggingTask', 'isSimpleQuestion', 'preferLowLatency'], false],
		['Отладь функцию, она выбрасывает исключение', 'debug the function, it throws an exception', 'code', ['isDebuggingTask'], false],
		['Приложение крашится, вот стектрейс', 'the app crashes, here is the stack trace', 'chat', ['isDebuggingTask', 'preferLowLatency'], false],
		['Проверь мой код', 'review my code', 'chat', ['isCodeReviewTask', 'preferLowLatency'], false],
		['Отрефактори эту функцию', 'refactor this function', 'chat', ['isCodeReviewTask', 'preferLowLatency'], false],
		['Как можно улучшить этот класс?', 'how can I improve this class', 'chat', ['isCodeReviewTask', 'isSimpleQuestion', 'preferLowLatency'], false],
		['Это хороший код?', 'is this good code?', 'chat', ['isCodeReviewTask', 'preferLowLatency'], false],
		['Напиши юнит-тесты для сервиса корзины', 'write unit tests for the cart service', 'chat', ['isTestingTask', 'preferLowLatency'], false],
		['Как протестировать асинхронные функции?', 'how to test async functions', 'chat', ['isSimpleQuestion', 'isTestingTask', 'preferLowLatency'], false],
		['Добавь тесты для редьюсера', 'add tests for the reducer', 'code', ['isTestingTask'], false],
		['Задокументируй эту функцию', 'document this function', 'chat', ['isDocumentationTask', 'preferLowLatency'], false],
		['Добавь комментарии в файл', 'add comments to the file', 'code', ['isDocumentationTask'], false],
		['Напиши ридми для проекта', 'write a readme for the project', 'code', ['isDocumentationTask', 'requiresComplexReasoning'], true],
		['Оптимизируй этот запрос', 'optimize this query', 'chat', ['isCodeReviewTask', 'isPerformanceTask', 'preferLowLatency'], false],
		['Страница тормозит, как ускорить отрисовку?', 'this page is slow, how to speed up rendering', 'chat', ['isPerformanceTask', 'preferLowLatency'], false],
		['Проблема с производительностью в списке', 'performance issue in the list view', 'chat', ['isDebuggingTask', 'isPerformanceTask', 'preferLowLatency'], false],
		['Это безопасно? Пароли хранятся открытым текстом', 'is this secure? passwords are stored in plain text', 'chat', ['isSecurityTask', 'preferLowLatency'], false],
		['Проверь на SQL-инъекции и XSS', 'check for sql injection and xss', 'chat', ['isSecurityTask', 'preferLowLatency'], false],
		['Посчитай среднее по столбцу', 'calculate the average of the column', 'chat', ['isMathTask', 'preferLowLatency'], false],
		['Реши уравнение x^2 = 4', 'solve the equation x^2 = 4', 'chat', ['isMathTask', 'preferLowLatency'], false],
		['Переведи код с питона на раст', 'translate code from python to rust', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], false],
		['Перепиши на Kotlin', 'rewrite in kotlin', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], false],
		['Конвертируй в TypeScript', 'convert to typescript', 'chat', ['isMultiLanguageTask', 'preferLowLatency'], false],
		['Сначала создай таблицу, потом добавь эндпоинт и напиши тесты', 'first create the table, then add endpoint and write tests', 'code', ['isMultiStepTask', 'isTestingTask'], false],
		['Построй API и интерфейс и документацию', 'build the api and the ui and the docs', 'code', ['isDocumentationTask', 'isMultiStepTask'], false],
		['Обнови конфиг и измени схему', 'update the config and modify the schema', 'chat', ['isMultiStepTask'], false],
		['Какова архитектура этого проекта?', 'what is the architecture of this project', 'code', ['requiresComplexReasoning'], true],
		['Опиши мою кодовую базу', 'describe my codebase', 'code', ['requiresComplexReasoning'], true],
		['Сколько эндпоинтов в API?', 'how many endpoints does the api have', 'code', ['requiresComplexReasoning'], true],
		['Что делает это приложение?', 'what does this app do', 'code', ['isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], true],
		['Какой фреймворк использует это приложение?', 'which framework does this app use', 'code', [], false],
		['Объясни почему этот алгоритм корректен', 'explain why this algorithm is correct', 'chat', ['isMathTask', 'isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], false],
		['Проанализируй компромиссы, сопоставь варианты', 'analyze the trade-offs, compare and contrast the options', 'chat', ['requiresComplexReasoning'], false],
		['Дай исчерпывающий и тщательный обзор', 'give a comprehensive and thorough overview', 'chat', ['requiresComplexReasoning'], false],
		['Подробный анализ тезиса и гипотезы', 'a detailed analysis of the thesis and its hypothesis', 'chat', ['requiresComplexReasoning'], false],
		['Реализуй форму входа с валидацией', 'implement a login form with validation', 'code', [], false],
		['Создай сервис, который разбирает даты', 'create a service that parses dates', 'code', [], false],
		['Добавь кнопку на панель', 'add a button to the toolbar', 'code', [], false],
		['Напиши код для сортировки массива', 'write code to sort an array', 'code', [], false],
		['Что такое замыкание в JavaScript?', 'What is a closure in JavaScript?', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Как мне развернуть строку в питоне', 'how do I reverse a string in python', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Объясни рекурсию', 'explain recursion', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Расскажи про погоду', 'tell me about the weather', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Почему небо голубое', 'why is the sky blue', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Можешь мне помочь с одним делом', 'can you help me with something', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Погугли последнюю версию node', 'search the web for the latest node release', 'web_search', [], false],
		['Где лежит конфиг', 'where is the config file', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Кто это написал', 'who wrote this', 'chat', ['isSimpleQuestion', 'preferLowLatency'], false],
		['Спасибо большое', 'thanks a lot', 'chat', ['preferLowLatency'], false],
		['ИСПРАВЬ ОШИБКУ В ПАРСЕРЕ', 'FIX ERROR IN THE PARSER', 'chat', ['isDebuggingTask', 'preferLowLatency'], false],
		['Объясни, почему нельзя делить на ноль', 'explain why you cannot divide by zero', 'chat', ['isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], false],
		['Найди уязвимости в этом коде', 'find vulnerabilities in this code', 'chat', ['isSecurityTask', 'preferLowLatency'], false],
		['Почини баг в парсере', 'fix bug in the parser', 'code', ['isDebuggingTask'], false],
		['Объясни, почему ёжик не работает', 'explain why the hedgehog is not working', 'chat', ['isDebuggingTask', 'isSimpleQuestion', 'preferLowLatency', 'requiresComplexReasoning'], false],
		['Нужен изощрённый подход', 'a sophisticated approach is needed', 'chat', ['requiresComplexReasoning'], false],
	];

	test('русский запрос читается так же, как его английская пара', () => {
		const expected = pairs.map(([, , taskType, flags, isCodebaseQuestion]) => ({ taskType, flags, isCodebaseQuestion }));
		assert.deepStrictEqual(pairs.map(([russian]) => wordingSignalsOf(russian)), expected);
		assert.deepStrictEqual(pairs.map(([, english]) => wordingSignalsOf(english)), expected);
	});

	/**
	 * Короткие русские основы лежат внутри чужих слов: «багаж», «логин», «проектор», «кодировка», «сложение», «скорая»
	 * Слова ищутся по границам слова, поэтому такие сообщения не дают ни одного признака работы
	 */
	test('обычные русские фразы со знакомыми корнями не дают признаков работы', () => {
		const neutral = [
			'Привет, как дела?', 'Какой сегодня день недели?', 'Кодировка файла в UTF-8', 'Проектор в зале не включается',
			'Мне нравится эта музыка', 'Забронируй багаж и логистику', 'Логин и пароль не подходят', 'Купи подарок на день рождения',
			'Тест на знание английского языка', 'Аргумент функции пустой', 'Сложение чисел в столбик', 'Мы слегка запутались',
			'Скорая помощь приехала быстро', 'Расскажи анекдот', 'Проектирование интерьера квартиры', 'Приложить к письму справку',
			'Составь план поездки в Казань', 'Переведи на английский: доброе утро', 'Как называется эта птица?',
			'Какие фильмы посмотреть вечером', 'Реши, что мне надеть', 'Кодовое слово от сейфа', 'Стек книг на столе',
			'Оценка за экзамен пришла', 'Перенеси встречу на завтра', 'Исправь опечатку в слове', 'Сделай чай',
		];
		// Light chat and a simple question are no work: only these two flags may be set
		const workOf = (message: string) => {
			const { taskType, flags, isCodebaseQuestion } = wordingSignalsOf(message);
			return { message, taskType, isCodebaseQuestion, work: flags.filter(flag => flag !== 'preferLowLatency' && flag !== 'isSimpleQuestion') };
		};
		assert.deepStrictEqual(neutral.map(workOf), neutral.map(message => ({ message, taskType: 'chat', isCodebaseQuestion: false, work: [] })));
	});

	test('регистр, ё и смесь языков не мешают', () => {
		assert.deepStrictEqual({
			'заглавные': signalsOf('ПРОАНАЛИЗИРУЙ ПРОЕКТ').flags,
			'ё вместо е': signalsOf('Нужен изощрённый подход').flags,
			'русская и английская просьба в одном сообщении': signalsOf('Fix the parser и исправь ошибку в тестах').flags,
		}, {
			'заглавные': ['requiresComplexReasoning'],
			'ё вместо е': ['requiresComplexReasoning'],
			'русская и английская просьба в одном сообщении': ['isDebuggingTask', 'isMultiStepTask'],
		});
	});
});

/** Просьба по-русски доходит до роутера теми же признаками, что и по-английски, и он выбирает так же */
suite('«Авто»: русский сложный код-вопрос выбирает думающую модель', () => {

	const store = ensureNoDisposablesAreLeakedInTestSuite();

	// The router logs a question about the codebase through `vibeLog`
	// The runner fails any test that writes to the console
	setup(() => vibeLog.configure({ enabled: false }));
	teardown(() => vibeLog.configure({ enabled: true }));

	const textModel = 'MiniMax-Text-01';
	const flashPreview = 'MiniMax-M3.1-Flash-Preview';
	const m3 = 'MiniMax-M3';
	const m2 = 'MiniMax-M2.7';

	function createMinimaxRouter(modelNames: readonly string[]): TaskAwareModelRouter {
		const state = {
			settingsOfProvider: {
				minimax: {
					...defaultSettingsOfProvider.minimax,
					apiKey: 'k',
					_didFillInProviderSettings: true,
					models: modelNames.map(modelName => ({ modelName, type: 'autodetected', isHidden: false })),
				},
			},
			overridesOfModel: {},
			globalSettings: defaultGlobalSettings,
		} as unknown as VibeideSettingsState;
		const settings = { state, onDidChangeState: Event.None } as unknown as IVibeideSettingsService;
		const disposables = store.add(new DisposableStore());
		return disposables.add(new TaskAwareModelRouter(settings, disposables.add(new InMemoryStorageService())));
	}

	test('сложный вопрос по коду и его английская пара: один порядок, Text-01 без рассуждения последняя', async () => {
		const router = createMinimaxRouter([textModel, flashPreview, m3, m2]);
		const rankingOf = async (message: string) => {
			const decision = await router.route(buildAutoTaskContext(message, { hasImages: false, hasPDFs: false }).context);
			return [decision.modelSelection.modelName, ...(decision.fallbackChain ?? []).map(model => model.modelName)];
		};
		const russian = await rankingOf('Проанализируй архитектуру проекта, найди узкие места в коде и исправь ошибки в парсере');
		const english = await rankingOf('Analyze the architecture of the project, find bottlenecks in the code and fix errors in the parser');
		assert.deepStrictEqual({ russian, english }, {
			russian: [flashPreview, m3, m2, textModel],
			english: [flashPreview, m3, m2, textModel],
		});
	});

	test('обычная просьба по-русски лёгкая: на ней думающая модель не получает бонуса, и первой стоит первая в списке', async () => {
		const router = createMinimaxRouter([textModel, flashPreview, m3, m2]);
		const decision = await router.route(buildAutoTaskContext('Придумай название для кофейни', { hasImages: false, hasPDFs: false }).context);
		assert.deepStrictEqual([decision.modelSelection.modelName, ...(decision.fallbackChain ?? []).map(model => model.modelName)], [textModel, flashPreview, m3, m2]);
	});
});
