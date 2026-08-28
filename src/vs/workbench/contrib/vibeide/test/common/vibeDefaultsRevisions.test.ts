/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Реестр ревизий общего набора (`versions.json` в VibeBrains) отвечает на вопрос, на который
// одна только пара «релиз vs диск» ответить не может: копия у пользователя — нетронутый сид
// прошлого релиза или его собственная правка. Первую обновлять безопасно, вторую трогать нельзя.
// Практическая ценность: `.vibe`, засеянные до появления lock-файла, перестают быть «unknown»
// навсегда — по совпадению с исторической sha они снова становятся обновляемыми.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { isUntouchedPastRevision } from '../../common/vibeDefaults.js';
import { VIBE_DEFAULTS_MANIFEST, VIBE_VERSIONS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

suite('vibeDefaults — реестр ревизий набора', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const current = '// ревизия 3\n';
	const past = '// ревизия 2\n';

	test('копия прошлой ревизии опознаётся как нетронутая', async () => {
		const revisions = [{ path: 'rules.md', version: 3, sha256: await sha256Hex(current), history: [await sha256Hex(past)] }];
		assert.strictEqual(await isUntouchedPastRevision('rules.md', past, revisions), true);
		assert.strictEqual(await isUntouchedPastRevision('rules.md', current, revisions), true);
	});

	test('правка пользователя нетронутой не считается', async () => {
		const revisions = [{ path: 'rules.md', version: 3, sha256: await sha256Hex(current), history: [await sha256Hex(past)] }];
		assert.strictEqual(await isUntouchedPastRevision('rules.md', '// мой текст\n', revisions), false);
	});

	test('CRLF-чекаут известной ревизии остаётся нетронутым', async () => {
		const revisions = [{ path: 'rules.md', version: 2, sha256: await sha256Hex(current), history: [] }];
		assert.strictEqual(await isUntouchedPastRevision('rules.md', current.replace(/\n/g, '\r\n'), revisions), true);
	});

	test('файла нет в реестре — судить не по чему', async () => {
		assert.strictEqual(await isUntouchedPastRevision('нет-такого.md', current, []), false);
	});

	test('реальный реестр покрывает весь засеваемый набор', () => {
		assert.ok(VIBE_VERSIONS_MANIFEST.length > 0, 'versions.json не попал в сборку');
		const known = new Set(VIBE_VERSIONS_MANIFEST.map(r => r.path));
		const uncovered = VIBE_DEFAULTS_MANIFEST.map(f => f.path).filter(p => !known.has(p));
		assert.deepStrictEqual(uncovered, [], 'сиды без записи о ревизии — их нельзя будет обновить');
		for (const r of VIBE_VERSIONS_MANIFEST) {
			assert.match(r.sha256, /^[0-9a-f]{64}$/, `${r.path}: битая sha`);
			assert.ok(r.version >= 1, `${r.path}: ревизия должна начинаться с 1`);
		}
	});
});
