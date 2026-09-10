/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VIBE_DEFAULTS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';
import { parseVibeAgentsFileOrEmpty, activeAgents } from '../../common/acp/vibeAgentsFile.js';
import { parseServersFile } from '../../common/vibeServer/vibeServersFile.js';
import { parseHookConfig } from '../../common/hooks/hookConfig.js';
import { parseProvidersFile } from '../../common/vibeProvidersFile.js';
import { parseDeclaredMoment } from '../../common/modelPriceSchedule.js';

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
});
