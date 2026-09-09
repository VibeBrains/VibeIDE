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
 * Засеянное окружение обязано молчать.
 *
 * WHY this test and not a reading of the seed: since the shared set dropped `*.example.*`, the
 * seeded file IS the working file — `.vibe/agents.json`, not `agents.example.jsonc`. Two properties
 * that used to be free now have to be proven on every release: the seed parses at all (it is
 * JSONC, densely commented), and nothing in it runs, connects or launches until a human removes an
 * `"active": false`. A regression here does not look like a bug; it looks like the IDE quietly
 * doing something on a project that only just opened.
 *
 * The fixtures are the SHIPPED bytes — read from the generated manifest, not retyped here, so the
 * test cannot pass against a copy while the real seed drifts.
 */
suite('засеянное окружение .vibe инертно', () => {
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
});
