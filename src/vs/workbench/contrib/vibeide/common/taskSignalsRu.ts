/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Russian counterparts of the English keyword tables that read a chat message into task signals
 * (`autoTaskSignals.ts`): the same signals, the same meaning, the words of the language the person writes in
 *
 * The English tables match by substring, which works for English and would be a trap here: a short Russian stem
 * sits inside many unrelated words. So a Russian entry is matched by word boundaries (`\b` knows no Cyrillic):
 *   `стем*`  any word that starts with the stem, so the stem is long enough to be unambiguous
 *   `слово`  exactly this word, for short words and for forms that a longer stem would drag unrelated words in with
 *   a space between tokens stands for any run of spaces
 * Every predicate takes the message lower-cased with `ё` folded into `е`
 */

const WORD_START = '(?<![\\p{L}\\p{N}])';
const WORD_END = '(?![\\p{L}\\p{N}])';

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Between the words of a phrase: spaces, and a comma that a person puts there («объясни, почему») */
const PHRASE_GAP = '[\\s,]+';

/** One entry of a table as a regular expression fragment */
function entryPattern(entry: string): string {
	return entry.trim().split(/\s+/).map(token => token.endsWith('*')
		? `${escapeRegExp(token.slice(0, -1))}\\p{L}*`
		: `${escapeRegExp(token)}${WORD_END}`).join(PHRASE_GAP);
}

const alternatives = (entries: readonly string[]): string => `(?:${entries.map(entryPattern).join('|')})`;

/** Does the text hold a word or phrase of the table, anywhere */
function anyOf(entries: readonly string[]): (text: string) => boolean {
	const pattern = new RegExp(`${WORD_START}${alternatives(entries)}`, 'u');
	return text => pattern.test(text);
}

/** Does the text begin with a word or phrase of the table */
function startsWithAny(entries: readonly string[]): (text: string) => boolean {
	const pattern = new RegExp(`^${alternatives(entries)}`, 'u');
	return text => pattern.test(text);
}

/** A word of the first table, then a word of the second one somewhere after it */
function first(before: readonly string[], after: readonly string[]): (text: string) => boolean {
	const pattern = new RegExp(`${WORD_START}${alternatives(before)}[\\s\\S]*?${WORD_START}${alternatives(after)}`, 'u');
	return text => pattern.test(text);
}

/** A word of the first table, then at most `gap` other words, then a word of the second one: «создай новый метод» */
function near(before: readonly string[], after: readonly string[], gap: number): (text: string) => boolean {
	const pattern = new RegExp(`${WORD_START}${alternatives(before)}(?:\\s+\\p{L}+){0,${gap}}\\s+${alternatives(after)}`, 'u');
	return text => pattern.test(text);
}

const or = (...predicates: ReadonlyArray<(text: string) => boolean>) => (text: string): boolean => predicates.some(predicate => predicate(text));
const and = (...predicates: ReadonlyArray<(text: string) => boolean>) => (text: string): boolean => predicates.every(predicate => predicate(text));

// ── Nouns the tables share ───────────────────────────────────────────────────────────────────────

/** «проект» in its forms; the stem `проект*` would add «проектор» and «проектирование» */
const PROJECT = ['проект', 'проекта', 'проекту', 'проектом', 'проекте', 'проекты', 'проектов', 'проектам', 'проектами', 'проектах'];
/** «код» in its forms; the stem `код*` would add «кодировка» and «кодек» */
const CODE = ['код', 'кода', 'коду', 'кодом', 'коде', 'коды', 'кодов', 'кодам', 'кодами', 'кодах'];
const CODEBASE = ['кодов* баз*', 'репозитори*', 'репо'];
const APPLICATION = ['приложени*'];
const THIS_OR_MY = [
	'мой', 'моя', 'мое', 'мои', 'моего', 'моей', 'мою', 'моем', 'моим',
	'этот', 'эта', 'это', 'эти', 'этого', 'этой', 'эту', 'этом', 'данн*', 'наш*', 'текущ*',
];

// ── Reasoning and complexity ─────────────────────────────────────────────────────────────────────

/** Words of a request that wants thinking: analysis, comparison, a hypothesis, an argument */
const REASONING = [
	'объясн* почему', 'поясн* почему', 'анализ*', 'проанализ*', 'сопостав*', 'противопостав*', 'оцени*',
	'критик*', 'раскритик*', 'рассужд*', 'логик*', 'логичн*', 'логическ*', 'дедукц*', 'дедуцир*', 'умозаключ*',
	'заключени*', 'аргументир*', 'аргументац*', 'тезис*', 'гипотез*', 'теоретическ*', 'концептуальн*',
];

const COMPLEXITY = [
	'сложн*', 'комплексн*', 'изощренн*', 'нюанс*', 'детальн* анализ*', 'подробн* анализ*', 'детальн* разбор*', 'подробн* разбор*',
	'глубок* понимани*', 'всеобъемлющ*', 'исчерпывающ*', 'тщательн*', 'основательн*',
];

export const ruRequiresComplexReasoning = or(anyOf(REASONING), anyOf(COMPLEXITY));

// ── A question about the whole codebase ──────────────────────────────────────────────────────────

const STRUCTURE = ['архитектур*', 'структур*', 'организаци*', 'устройств*'];
const WHAT_IS = ['что такое', 'что делает', 'что делают', 'что за', 'что это'];
const COUNTED_THINGS = ['эндпоинт*', 'роут*', 'маршрут*', 'api', 'файл*', 'функци*', 'класс*', 'компонент*', 'модул*', 'сервис*', 'контроллер*'];

/** Words that name the codebase as a whole; «проект» alone is enough, as the English `project` is */
const CODEBASE_INDICATORS = [
	...CODEBASE, 'структур* проект*', 'структур* файл*', 'архитектур*', 'эндпоинт*', 'роут*', 'маршрут*', 'организаци* кода', 'устройств* проекта',
];

const whatIsMyCodebase = and(startsWithAny(WHAT_IS), anyOf(THIS_OR_MY), or(anyOf(CODE), anyOf(APPLICATION)));
const summarizeMyCode = and(startsWithAny(['опиш*', 'объясн*', 'проанализ*', 'суммир*', 'резюмир*', 'обзор*']), anyOf(THIS_OR_MY), anyOf(CODE));
const howManyThings = or(...COUNTED_THINGS.map(thing => anyOf([`сколько ${thing}`])));
const codebaseQuestionStarters = startsWithAny(['что такое', 'что делает', 'сколько', 'суммир*', 'резюмир*', 'объясн*', 'опиш*', 'обзор*']);

/** The part the chat reads into «requires complex reasoning»: a question about the whole codebase */
export const ruCodebaseQuestionForContext = or(
	anyOf([...CODEBASE, ...PROJECT]),
	first(STRUCTURE, [...CODE, ...PROJECT, ...CODEBASE]),
	whatIsMyCodebase,
	howManyThings,
	summarizeMyCode,
	and(anyOf(CODEBASE_INDICATORS), codebaseQuestionStarters),
);

const asksAboutFeaturesOrStack = and(
	startsWithAny(['какие', 'какой', 'какая', 'какое', 'что', 'как']),
	anyOf(['возможност*', 'функционал*', 'функци*', 'эндпоинт*', 'роут*', 'маршрут*', 'технологи*', 'фреймворк*', 'библиотек*', 'зависимост*', 'пакет*', 'стек*']),
	anyOf(THIS_OR_MY),
	or(anyOf(APPLICATION), anyOf(CODE)),
);
const codebaseQuestionTypeStarters = startsWithAny([
	'что такое', 'что делает', 'что делают', 'что это', 'сколько', 'как работает', 'как устроен*', 'суммир*', 'резюмир*', 'объясн*', 'опиш*', 'обзор*',
	'проанализ*', 'разбер*', 'какие', 'какой', 'какая', 'какое', 'каких', 'где',
]);

/**
 * The wider reading that picks the task type «code»
 * It adds the reverse order of the structure and the code, and questions about the features and the stack
 */
export const ruCodebaseQuestionForType = or(
	ruCodebaseQuestionForContext,
	first([...CODE, ...PROJECT, ...CODEBASE], STRUCTURE),
	asksAboutFeaturesOrStack,
	and(anyOf(CODEBASE_INDICATORS), codebaseQuestionTypeStarters),
);

// ── A task that writes or changes code, and a search of the web ─────────────────────────────────

/**
 * Verbs that open a request to build something; forms are listed because the stems collide with nouns («настройки»)
 * «Сделай» is left out: it opens as many requests for tea and a summary as for code, which the English `make` does too
 */
const BUILD_VERBS = [
	'реализуй', 'реализуйте', 'создай', 'создайте', 'добавь', 'добавьте', 'построй', 'постройте',
	'настрой', 'настройте', 'сконфигурируй', 'сконфигурируйте', 'собери', 'соберите',
];
const MAKE_VERB_STEMS = ['реализ*', 'созда*', 'добав*', 'постро*', 'сдела*', 'настро*', 'напиш*', 'сгенерир*', 'разработ*', 'собер*'];
const THINGS_TO_BUILD = [
	'функци*', 'класс*', 'метод*', 'компонент*', 'фич*', 'возможност*', 'эндпоинт*', 'роут*', 'маршрут*', 'api', 'сервис*', 'модул*', 'систем*', 'функционал*',
];

const implementationPatterns = or(
	and(startsWithAny(BUILD_VERBS), (text: string) => /^\p{L}+\s+\p{L}/u.test(text)),
	near(MAKE_VERB_STEMS, THINGS_TO_BUILD, 2),
	(text: string) => new RegExp(`${WORD_START}${alternatives(['реализ*', 'созда*', 'добав*', 'постро*', 'сдела*'])}\\s+\\p{L}+\\s+(?:котор\\p{L}*|чтобы|для)${WORD_END}`, 'u').test(text),
);
const implementationKeywords = anyOf([
	'напиш* код*', 'сгенерир* код*', 'созда* функци*', 'реализ* класс*', 'реализ* функци*', 'добав* функци*', 'созда* метод*',
	'исправ* баг*', 'почин* баг*', 'рефактор* код*', 'оптимиз* код*', 'отлад*', 'дебаг*',
	'синтаксическ* ошибк*', 'ошибк* компиляции', 'ошибк* сборки', 'созда* нов*', 'добав* нов*', 'реализ* нов*', 'постро* нов*',
	'настрой', 'настройте', 'настроить', 'сконфигурируй', 'сконфигурировать', 'разработай', 'разработайте', 'разработать',
]);
export const ruImplementationTask = or(implementationPatterns, implementationKeywords);

export const ruWebSearch = anyOf([
	'погугли', 'загугли', 'гугл*', 'дакдакго', 'поищи в интернет*', 'найди в интернет*', 'поиск в интернет*', 'поищи в сет*', 'поиск в сет*',
	'найди в сет*', 'поищи онлайн', 'найди онлайн', 'поищи в вебе',
]);

// ── The kinds of work a message can be about ─────────────────────────────────────────────────────

export const ruDebuggingTask = anyOf([
	'отлад*', 'дебаг*', 'ошибк*', 'ошибоч*', 'исключени*', 'стектрейс*', 'трассировк* стека', 'стек вызовов', 'не работает', 'не работают',
	'не работал*', 'не запускается', 'не запускаются', 'не запускал*', 'не компилируется', 'не собирается', 'сломал*', 'сломан*',
	'краш*', 'падает', 'падают', 'вылетает', 'вылетают', 'баг', 'баги', 'багу', 'бага', 'багом', 'багов', 'багфикс*',
	'проблем*', 'неполадк*', 'сбой', 'сбои', 'сбоя', 'сбое',
]);

export const ruCodeReviewTask = or(
	anyOf([
		'ревью', 'ревьюир*', 'рецензи*', 'рефактор*', 'отрефактор*', 'оптимиз*', 'бест-практис*', 'лучш* практик*', 'качеств* кода',
		'улучш* код*', 'улучш* реализаци*', 'почист* код*', 'очист* код*', 'предлож* улучшени*', 'как улучшить', 'можно лучше',
	]),
	near(['провер*'], CODE, 2),
	near(['улучш*'], ['этот', 'эту', 'это', 'мой', 'мою', 'функци*', 'класс*', 'метод*'], 0),
	near(['это', 'такой', 'мой'], ['хороший код', 'хорошего кода'], 1),
);

export const ruTestingTask = or(
	anyOf(['тестир*', 'протестир*', 'юнит-тест*', 'юнит тест*', 'модульн* тест*', 'интеграционн* тест*', 'тест-кейс*', 'тест-сьют*', 'покрыти* тест*']),
	near(['напиш*', 'добав*', 'созда*', 'сдела*', 'покро*'], ['тест', 'теста', 'тесту', 'тестом', 'тесте', 'тесты', 'тестов', 'тестам', 'тестами', 'тестах'], 2),
);

export const ruDocumentationTask = or(
	anyOf(['документаци*', 'документир*', 'задокументир*', 'коммент*', 'прокоммент*', 'ридми', 'докстринг*', 'доки']),
	near(['объясн*', 'поясн*', 'опиш*'], ['код', 'кода', 'функци*', 'класс*', 'метод*'], 2),
);

export const ruPerformanceTask = anyOf([
	'оптимиз*', 'производительност*', 'быстродействи*', 'ускор*', 'тормоз*', 'медленн*', 'быстрее', 'узк* мест*', 'профилир*', 'профайл*',
	'скорост*', 'эффективност*', 'долго работает',
]);

export const ruSecurityTask = anyOf([
	'безопасн*', 'уязвим*', 'аутентификац*', 'авторизац*', 'шифрова*', 'зашифр*', 'инъекц*',
]);

export const ruMathTask = or(
	anyOf(['посчита*', 'вычисл*', 'рассчита*', 'математик*', 'математическ*', 'алгоритм*', 'формул*', 'статистик*', 'уравнени*', 'численн*', 'арифметик*']),
	near(['реши', 'решите', 'решить', 'решай'], ['задач*', 'уравнени*', 'пример*'], 1),
);

export const ruMultiLanguageTask = or(
	anyOf(['переведи код', 'перевод кода', 'портир*', 'конвертир*', 'нескольк* язык*', 'разн* язык*', 'друг* язык*', 'на другой язык']),
	near(['перевед*', 'перевод*'], ['код', 'кода', 'этот', 'этот код'], 1),
	near(['перепиш*', 'перенес*', 'перенеси', 'портир*', 'конвертир*'], ['на', 'в'], 0),
);

// ── A simple question ────────────────────────────────────────────────────────────────────────────

/** Words of a request that is no simple question: it reads, changes or fixes the code */
export const ruComplexWorkWords = anyOf([
	...CODEBASE, 'архитектур*', 'анализ*', 'проанализ*', 'рефактор*', 'реализ*', 'отлад*', 'дебаг*', 'ошибк*', 'исправ*', 'почин*', 'пофикс*', 'ревью', 'ревьюир*', 'рецензи*',
]);

/** «Как» followed by an infinitive is the English «how to»: «как протестировать», «как развернуть строку» */
const HOW_TO = /^как\s+\p{L}*(?:ть|ться|сти|чь)(?![\p{L}\p{N}])/u;

/** How a simple question opens: what is, how to, explain, when, can you */
const simpleQuestionWords = startsWithAny([
	'что такое', 'что делает', 'что делают', 'что значит', 'что означает', 'что это',
	'как мне', 'как можно', 'как сделать', 'как работает', 'как узнать', 'как использовать', 'как пользоваться',
	'объясн*', 'расскаж*', 'опиш*', 'поясн*',
	'когда', 'где', 'почему', 'зачем', 'кто',
	'можешь', 'можете', 'сможешь', 'сможете', 'мог бы', 'могла бы',
]);
export const ruSimpleQuestionStarter = (text: string): boolean => simpleQuestionWords(text) || HOW_TO.test(text);

// ── Several steps ────────────────────────────────────────────────────────────────────────────────

/** The English table counts distinct verbs; each slot here is one verb of it, with the forms a person writes */
const ACTION_VERB_SLOTS: ReadonlyArray<(text: string) => boolean> = [
	['реализуй', 'реализуйте', 'реализовать', 'реализовал*'],
	['создай', 'создайте', 'создать', 'создал*'],
	['добавь', 'добавьте', 'добавить', 'добавлять'],
	['построй', 'постройте', 'построить', 'собери', 'соберите', 'собрать'],
	['сделай', 'сделайте', 'сделать'],
	['настрой', 'настройте', 'настроить', 'сконфигурируй', 'сконфигурировать'],
	['напиши', 'напишите', 'написать'],
	['сгенерируй', 'сгенерируйте', 'сгенерировать'],
	['разработай', 'разработайте', 'разработать'],
	['исправь', 'исправьте', 'исправить', 'почини', 'почините', 'починить', 'пофикси', 'пофиксить'],
	['обнови', 'обновите', 'обновить'],
	['измени', 'измените', 'изменить', 'модифицир*'],
].map(forms => anyOf(forms));

export const ruActionVerbCount = (text: string): number => ACTION_VERB_SLOTS.filter(slot => slot(text)).length;

/** The Russian «и» between two actions; the English table counts `and` the same way */
export const ruConjunctionCount = (text: string): number => (text.match(/\sи\s/g) ?? []).length;

export const ruMultiStepKeyword = anyOf([
	'потом', 'затем', 'после этого', 'далее', 'также', 'а также', 'кроме того', 'дополнительно', 'более того', 'к тому же',
	'шаг', 'шаги', 'шагов', 'шага', 'шагом', 'этап*', 'пошагов*', 'по шагам', 'следующ*',
]);
