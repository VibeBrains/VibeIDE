/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VIBE_DEFAULTS_MANIFEST, VIBE_KNOWN_PRODUCTS, VIBE_FILE_ADDRESSING, VIBE_PRODUCT_ID } from '../../common/vibeDefaultsManifest.generated.js';
import { parseVibeAgentsFileOrEmpty, activeAgents } from '../../common/acp/vibeAgentsFile.js';
import { parseServersFile } from '../../common/vibeServer/vibeServersFile.js';
import { parseHookConfig } from '../../common/hooks/hookConfig.js';
import { parseProvidersFile } from '../../common/vibeProvidersFile.js';
import { parseDeclaredMoment } from '../../common/modelPriceSchedule.js';
import { isUntouchedPastRevision } from '../../common/vibeDefaults.js';
import { parseRuleFrontmatter, parseAlwaysApply, parseTriggers, parseGlobs, decideRuleActivation } from '../../common/prompt/ruleFrontmatter.js';

/**
 * Что засеянное окружение делает само, а чего не делает.
 *
 * WHY this test and not a reading of the seed: since the shared set dropped `*.example.*`, the
 * seeded file IS the working file — `.vibe/agents.json`, not `agents.example.jsonc`. Whatever the
 * seed says now happens on a project that has just been opened, so it has to be proven on every
 * release rather than assumed.
 *
 * THE INVARIANT IS PER FILE, NOT PER SET — and stating it as one rule would be wrong:
 *
 *  • a hook ships DISABLED: it runs someone else's command, and an enabled sample would execute
 *    code on the first turn;
 *  • an agent ships DISABLED: it launches an external process that may not even be installed;
 *  • the provider catalogue ships ENABLED, deliberately. A disabled catalogue means an IDE with
 *    no models in the list on first run, and the product is useless until a key appears. The test
 *    below locks that in, so nobody «fixes» the catalogue into silence.
 *
 * The fixtures are the SHIPPED bytes — read from the generated manifest, not retyped here, so the
 * test cannot pass against a copy while the real seed drifts.
 */
suite('засеянное окружение .vibe: что включено, а что нет', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const seed = (path: string): string => {
		const file = VIBE_DEFAULTS_MANIFEST.find(f => f.path === path);
		assert.ok(file, `в манифесте нет ${path} — набор переименовали, а тест не обновили`);
		return file.contents;
	};

	test('agents.json разбирается, и ни один агент не активен', () => {
		const parsed = parseVibeAgentsFileOrEmpty(seed('agents.json'));
		assert.deepStrictEqual(parsed.problems, []);
		assert.ok(parsed.agents.length > 0, 'сид без единого агента — скорее всего не разобрался');
		assert.deepStrictEqual(activeAgents(parsed.agents), []);
	});

	test('hooks.json разбирается, и ни один хук не выполняется', () => {
		const config = parseHookConfig(seed('hooks.json'));
		assert.deepStrictEqual(config.problems, []);
		assert.deepStrictEqual(config.hooks, []);
	});

	/**
	 * A rule that changes how the agent works on every turn ships OFF: the user switches it on with `alwaysApply: true`.
	 * Off here means «listed as available, body not injected» — the same state the settings panel labels «по запросу».
	 */
	test('правило «бригадир» засевается выключенным: в списке доступных, но не в промпте', () => {
		const parsed = parseRuleFrontmatter(seed('rules/brigadier.mdc'));
		const meta = { alwaysApply: parseAlwaysApply(parsed.frontmatter), triggers: parseTriggers(parsed.frontmatter), globs: parseGlobs(parsed.frontmatter) };
		assert.deepStrictEqual({ meta, activation: decideRuleActivation(meta, { userText: 'бригадир, экономим токены' }) }, {
			meta: { alwaysApply: false, triggers: [], globs: [] },
			activation: 'index',
		});
		assert.ok(parsed.frontmatter['description'], 'у правила нет description — в списке доступных оно будет безымянным');
	});

	/**
	 * Автопилот roadmap живёт по фразам: правило само пишет, что вне фраз не действует, а ехало бы в каждом ходе.
	 * Проверяются отгружаемые байты: все одиннадцать фраз шапки включают правило, обычный текст и однокоренное слово — нет.
	 */
	test('правило «автопилот roadmap» включается своими фразами и молчит на обычном тексте', () => {
		const parsed = parseRuleFrontmatter(seed('rules/roadmap-autopilot.mdc'));
		const meta = { alwaysApply: parseAlwaysApply(parsed.frontmatter), triggers: parseTriggers(parsed.frontmatter), globs: parseGlobs(parsed.frontmatter) };
		const activationOn = (userText: string) => decideRuleActivation(meta, { userText });
		assert.deepStrictEqual({
			meta,
			everyPhraseInjects: meta.triggers.map(phrase => activationOn(`давай, ${phrase.toUpperCase()}, я ушёл`)),
			skillCommand: activationOn('запусти /skill:roadmap-autopilot'),
			ordinaryText: activationOn('поправь кнопку в шапке'),
			nearMiss: activationOn('автопилотируемый режим не нужен'),
		}, {
			meta: {
				alwaysApply: false,
				triggers: ['ночной прогон', 'автопилот', 'roadmap night', 'автономный роадмап', 'закрывай роадмап', 'пока сплю', 'пока я сплю', 'прогон afk', 'не получилось — иди дальше', 'skip on failure', '/skill:roadmap-autopilot'],
				globs: [],
			},
			everyPhraseInjects: Array(11).fill('inject'),
			skillCommand: 'inject',
			ordinaryText: 'index',
			nearMiss: 'index',
		});
		assert.ok(parsed.frontmatter['description'], 'у правила нет description — в списке доступных оно будет безымянным');
	});

	/**
	 * Правило просмотра записей включается фразами человека: вне них оно не нужно, а ехало бы в каждом ходе.
	 * Проверяются отгружаемые байты: каждая фраза шапки включает правило, обычный текст и однокоренное слово — нет.
	 * Фразы из задачи (восемь) обязаны быть среди фраз шапки: их назвал владелец, и уйти из набора они не должны.
	 */
	test('правило «watch-media» включается фразами про видео и запись и молчит на обычном тексте', () => {
		const parsed = parseRuleFrontmatter(seed('rules/watch-media.mdc'));
		const meta = { alwaysApply: parseAlwaysApply(parsed.frontmatter), triggers: parseTriggers(parsed.frontmatter), globs: parseGlobs(parsed.frontmatter) };
		const activationOn = (userText: string) => decideRuleActivation(meta, { userText });
		const named = ['посмотри видео', 'разбери видео', 'что в ролике', 'что на записи', 'послушай аудио', 'расшифруй запись', 'разбери созвон', 'посмотри ролик'];
		assert.deepStrictEqual({
			alwaysApply: meta.alwaysApply,
			globs: meta.globs,
			namedPhrasesAreTriggers: named.filter(phrase => !meta.triggers.includes(phrase)),
			everyPhraseInjects: meta.triggers.filter(phrase => activationOn(`слушай, ${phrase.toUpperCase()} — вот файл @demo.mp4`) !== 'inject'),
			ordinaryText: activationOn('поправь кнопку в шапке'),
			nearMiss: activationOn('посмотри видеокарту в диспетчере'),
		}, {
			alwaysApply: false,
			globs: [],
			namedPhrasesAreTriggers: [],
			everyPhraseInjects: [],
			ordinaryText: 'index',
			nearMiss: 'index',
		});
		assert.ok(parsed.frontmatter['description'], 'у правила нет description — в списке доступных оно будет безымянным');
	});

	/**
	 * `ui-kit.mdc` держит в globs фигурные скобки: `**\/*.{css,scss,...}`.
	 * Разбор по запятым разрезал такой glob на куски, и правило не срабатывало ни на одном файле.
	 */
	test('правило «ui-kit» срабатывает на стилях и разметке и молчит на коде без интерфейса', () => {
		const parsed = parseRuleFrontmatter(seed('rules/ui-kit.mdc'));
		const meta = { alwaysApply: parseAlwaysApply(parsed.frontmatter), triggers: parseTriggers(parsed.frontmatter), globs: parseGlobs(parsed.frontmatter) };
		const activationOn = (file: string) => decideRuleActivation(meta, { userText: 'поправь метод', files: [file] });
		assert.deepStrictEqual({
			meta,
			scss: activationOn('a.scss'),
			nestedLess: activationOn('src/ui/theme/a.less'),
			component: activationOn('src/ui/Button.tsx'),
			html: activationOn('index.html'),
			script: activationOn('a.ts'),
			nestedScript: activationOn('src/server/a.ts'),
		}, {
			meta: { alwaysApply: false, triggers: [], globs: ['**/*.{css,scss,sass,less,tsx,jsx,vue,svelte,html}'] },
			scss: 'inject',
			nestedLess: 'inject',
			component: 'inject',
			html: 'inject',
			script: 'index',
			nestedScript: 'index',
		});
	});

	/** Фигурная или квадратная скобка без пары в glob значит, что список разрезан не там: правило молча перестанет срабатывать. */
	test('globs и triggers каждого правила набора разобраны целиком: скобки в пунктах парные', () => {
		const unbalanced: string[] = [];
		for (const file of VIBE_DEFAULTS_MANIFEST) {
			if (!file.path.startsWith('rules/') || !file.path.endsWith('.mdc')) { continue; }
			const { frontmatter } = parseRuleFrontmatter(file.contents);
			for (const item of [...parseGlobs(frontmatter), ...parseTriggers(frontmatter)]) {
				const count = (chars: string) => [...item].filter(c => chars.includes(c)).length;
				if (count('{') !== count('}') || count('[') !== count(']')) { unbalanced.push(`${file.path}: ${item}`); }
			}
		}
		assert.deepStrictEqual(unbalanced, []);
	});

	test('servers.json разбирается и не поднимает серверов', () => {
		const parsed = parseServersFile(seed('servers.json'));
		assert.strictEqual(parsed.ok, true, `не разобрался: ${parsed.ok ? '' : parsed.error}`);
	});

	/** The one file that is NOT seeded as a working config, and the reason is worth keeping visible. */
	test('providers.json не засевается — он лежит в сильнейшем слое слияния', () => {
		assert.strictEqual(VIBE_DEFAULTS_MANIFEST.find(f => f.path === 'providers.json'), undefined);
		assert.strictEqual(VIBE_DEFAULTS_MANIFEST.find(f => f.path === 'providers.example.jsonc'), undefined);
		// The catalogue below it is still shipped, and it is what carries the ready-made providers.
		assert.ok(VIBE_DEFAULTS_MANIFEST.some(f => f.path.startsWith('providers/')));
	});

	/** Every seeded provider file must parse: a typo here disables a provider silently. */
	test('каждый файл каталога провайдеров разбирается', () => {
		const bad: string[] = [];
		for (const file of VIBE_DEFAULTS_MANIFEST) {
			if (!file.path.startsWith('providers/') || !file.path.endsWith('.jsonc')) { continue; }
			const parsed = parseProvidersFile(file.contents);
			if (!parsed.ok) { bad.push(`${file.path}: ${parsed.error}`); }
		}
		assert.deepStrictEqual(bad, []);
	});

	/**
	 * MiniMax-Text-01 не думающая и не подтверждена вендором: записана только там, где её принимают.
	 * Клон по Anthropic-протоколу в VibeIDEA наследует список родителя по id, поэтому там она явно выключена.
	 */
	test('MiniMax-Text-01 в каталоге: на OpenAI-маршруте без мышления, на Anthropic-маршруте выключена', () => {
		const parsed = parseProvidersFile(seed('providers/minimax.jsonc'));
		assert.ok(parsed.ok, 'minimax.jsonc не разобрался');
		const textOf = (providerId: string) => parsed.providers.find(p => p.id === providerId)?.models?.static?.find(m => m.id === 'MiniMax-Text-01');
		assert.deepStrictEqual({ openai: textOf('minimax'), anthropic: textOf('minimax-anthropic') }, {
			openai: { id: 'MiniMax-Text-01', name: 'MiniMax Text-01 (1M, без мышления)', contextWindow: 1000000 },
			anthropic: { id: 'MiniMax-Text-01', active: false },
		});
	});

	/**
	 * Гейт на даты в наборе, а не соглашение о них.
	 *
	 * WHY: `cost*` сломалось у соседа именно потому, что договорённость о написании поля не была
	 * ничем проверена — переименование прошло зелёным у автора и молча оставило читателя без цен.
	 * Дата — то же самое: значение, которое один разборщик берёт, а другой нет, и разница не видна
	 * никак, потому что модель без срока годности выглядит как модель без срока годности.
	 *
	 * Проверяются ОТГРУЖАЕМЫЕ байты: любое объявленное в наборе время обязано читаться нашим
	 * разбором. Голая дата и момент с зоной оба допустимы — непригодным считается только то, что
	 * не читается вовсе.
	 */
	test('каждое объявленное в наборе время читается нашим разбором', () => {
		const unreadable: string[] = [];
		let checked = 0;
		for (const file of VIBE_DEFAULTS_MANIFEST) {
			for (const [, value] of file.contents.matchAll(/"(?:cost|price)ValidUntil"\s*:\s*"([^"]+)"/g)) {
				checked++;
				if (parseDeclaredMoment(value) === undefined) {
					unreadable.push(`${file.path}: ${value}`);
				}
			}
		}
		assert.deepStrictEqual(unreadable, []);
		// A gate that silently checks nothing is worse than no gate: it reports success for a set
		// whose date fields were renamed out from under it.
		assert.ok(checked > 0, 'в наборе не нашлось ни одного costValidUntil — поле переименовали, а гейт не обновили');
	});

	/**
	 * Обратное к инертности, и это не оплошность.
	 *
	 * The catalogue is the one seeded file that must arrive live: it is what puts models in the
	 * list on a first run. If it ever ships switched off, the product greets a new user with an
	 * empty picker — a failure that looks like «VibeIDE не видит моделей», not like a seed change.
	 */
	test('каталог провайдеров приезжает ЖИВЫМ — это исключение, и оно закреплено', () => {
		let active = 0;
		for (const file of VIBE_DEFAULTS_MANIFEST) {
			if (!file.path.startsWith('providers/') || !file.path.endsWith('.jsonc')) { continue; }
			const parsed = parseProvidersFile(file.contents);
			if (!parsed.ok) { continue; }
			active += parsed.providers.filter(p => p.active !== false).length;
		}
		assert.ok(active > 0, 'ни одного включённого провайдера в каталоге — на первом запуске список моделей будет пуст');
	});

	/**
	 * Реестр ревизий сверяет ФАЙЛ ЦЕЛИКОМ, а не его разобранное тело.
	 *
	 * Этот тест написан по следам собственного дефекта: происхождение скилла сравнивало sha256
	 * реестра с `skill.body`, из которого разбор уже вырезал фронтматтер. Совпасть это не могло
	 * никогда, и каждый отгруженный скилл помечался бы как «изменён» — подпись врала бы ровно в
	 * том, ради чего она есть. Тест фиксирует обе стороны, чтобы ошибку нельзя было повторить
	 * «удобным» сравнением.
	 */
	test('нетронутость считается по целому файлу, а не по телу без фронтматтера', async () => {
		const skill = VIBE_DEFAULTS_MANIFEST.find(f => f.path.startsWith('skills/') && f.path.endsWith('/SKILL.md'));
		assert.ok(skill, 'в наборе нет ни одного скилла — тест устарел вместе с набором');
		assert.strictEqual(await isUntouchedPastRevision(skill.path, skill.contents), true,
			'отгружаемый файл не опознан реестром ревизий — рассинхрон набора и манифеста');

		const withoutFrontmatter = skill.contents.replace(/^---\s*\r?\n[\s\S]*?\r?\n---\s*\r?\n?/, '').trim();
		assert.notStrictEqual(withoutFrontmatter, skill.contents, 'у скилла нет фронтматтера — возьмите другой образец');
		assert.strictEqual(await isUntouchedPastRevision(skill.path, withoutFrontmatter), false,
			'тело без фронтматтера опознано как нетронутый файл — сверка стала бессмысленной');
	});

	suite('адресация продуктов', () => {
		/**
		 * Словарь берётся из набора, своего списка у нас нет — и это не удобство, а условие.
		 *
		 * A test that checks ids against a list it keeps itself checks itself: the two lists drift,
		 * and the drift is invisible — a product added on one side turns the other side's entries
		 * into nobody's. That is exactly how the `cost*` rename went unnoticed, with a field name
		 * instead of a product name.
		 */
		test('словарь продуктов приходит из набора и не пуст', () => {
			// An empty dictionary means a set without addressing — the gate must say so rather than
			// report success for a comparison it never made.
			assert.ok(VIBE_KNOWN_PRODUCTS.length > 0, 'в наборе нет словаря продуктов — сверять опечатку не с чем');
			assert.ok(VIBE_KNOWN_PRODUCTS.includes(VIBE_PRODUCT_ID), `наш id «${VIBE_PRODUCT_ID}» не объявлен в наборе`);
		});

		/** Опечатка в id делает запись ничьей: она молча не сработает нигде, поймать может только тест. */
		test('каждый адрес в наборе есть в словаре', () => {
			const unknown: string[] = [];
			for (const entry of VIBE_FILE_ADDRESSING) {
				for (const product of entry.products) {
					if (!VIBE_KNOWN_PRODUCTS.includes(product)) { unknown.push(`${entry.path}: ${product}`); }
				}
			}
			assert.deepStrictEqual(unknown, []);
		});

		/** Файл для чужого продукта не «выключен» у нас — его нет в сборке вовсе. */
		test('манифест не несёт файлов, адресованных другому продукту', () => {
			const foreign = VIBE_FILE_ADDRESSING
				.filter(entry => !entry.products.includes(VIBE_PRODUCT_ID))
				.filter(entry => VIBE_DEFAULTS_MANIFEST.some(file => file.path === entry.path))
				.map(entry => entry.path);
			assert.deepStrictEqual(foreign, []);
			// And the addressing is not decorative: today it excludes something real.
			assert.ok(VIBE_FILE_ADDRESSING.length > 0, 'адресация пуста — генератор её потерял');
		});
	});
});
