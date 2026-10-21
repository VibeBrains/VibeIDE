/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Основа слияния сидов `.vibe`: текст ревизии набора, от которой засеян файл (формат — `seedBaseSpec.md` набора).
// Без неё конфликт сида разбирается двумя сторонами и сводится к «взять релиз целиком»: журнал хранит только хеши,
// а по хешу текст не восстановить. Эти тесты стерегут три вещи: когда основа пишется, когда НЕ пишется
// (правленому файлу её не придумать) и что решение человека «оставить своё» больше не превращается в «обновить безопасно»,
// когда набор уйдёт дальше.

import * as assert from 'assert';
import { VSBuffer } from '../../../../../base/common/buffer.js';
import { Schemas } from '../../../../../base/common/network.js';
import { StringSHA1 } from '../../../../../base/common/hash.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { FileOperation, IFileService } from '../../../../../platform/files/common/files.js';
import { FileService } from '../../../../../platform/files/common/fileService.js';
import { InMemoryFileSystemProvider } from '../../../../../platform/files/common/inMemoryFilesystemProvider.js';
import { NullLogService } from '../../../../../platform/log/common/log.js';
import {
	applyVibeDefaults,
	diffVibeDefaults,
	recordVibeDefaultsReconciled,
	refreshSeedBases,
	VIBE_DEFAULTS_LOCK_FILE,
} from '../../common/vibeDefaults.js';
import { VIBE_DEFAULTS_MANIFEST } from '../../common/vibeDefaultsManifest.generated.js';
import { planSeedMerge, readSeedBase, recordSeedBases, seedBasesPresent, seedBaseUri } from '../../common/vibeSeedBase.js';

const PATH = 'README.md';
const VIBE_DIR = URI.file('/ws/.vibe');

async function sha256Hex(text: string): Promise<string> {
	const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text.replace(/\r\n/g, '\n')));
	return Array.from(new Uint8Array(digest)).map(b => b.toString(16).padStart(2, '0')).join('');
}

/** Хеш журнала — SHA-1 по тексту с LF, как в `vibeDefaults.ts`. */
function lockSha(text: string): string {
	const h = new StringSHA1();
	h.update(text.replace(/\r\n/g, '\n'));
	return h.digest();
}

suite('vibeSeedBase — основа слияния сидов .vibe', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const release = VIBE_DEFAULTS_MANIFEST.find(f => f.path === PATH)!.contents;
	const past = '# прошлая ревизия набора\n\nстарый текст\n';
	const mine = '# моя правка\n';

	function createFileService(): IFileService {
		const fileService = disposables.add(new FileService(new NullLogService()));
		disposables.add(fileService.registerProvider(Schemas.file, disposables.add(new InMemoryFileSystemProvider())));
		return fileService;
	}

	const write = (fileService: IFileService, path: string, text: string) =>
		fileService.writeFile(URI.file(`/ws/.vibe/${path}`), VSBuffer.fromString(text));

	const writeLock = (fileService: IFileService, entry: { release: string; local: string }) =>
		write(fileService, VIBE_DEFAULTS_LOCK_FILE, JSON.stringify({ version: 1, files: { [PATH]: entry } }));

	/** Ревизия `past` — известная набору: нетронутая копия опознаётся без журнала. */
	async function revisions() {
		return [{ path: PATH, version: 2, sha256: await sha256Hex(release), history: [await sha256Hex(past)] }];
	}

	test('решение «оставить своё» сохраняет основу — ревизию, которую человек увидел', async () => {
		const fileService = createFileService();
		await write(fileService, PATH, mine);
		await recordVibeDefaultsReconciled(fileService, VIBE_DIR, [PATH]);
		assert.strictEqual(await readSeedBase(fileService, VIBE_DIR, PATH), release);
	});

	test('засев пишет основу вместе с файлом; папка основы сама закрыта от git', async () => {
		const fileService = createFileService();
		await applyVibeDefaults(fileService, VIBE_DIR, { only: [PATH] });
		assert.deepStrictEqual(
			{
				base: await readSeedBase(fileService, VIBE_DIR, PATH),
				ignore: (await fileService.readFile(URI.file('/ws/.vibe/local/seedBase/.gitignore'))).value.toString().split('\n').includes('*'),
			},
			{ base: release, ignore: true },
		);
	});

	test('основа хранится с LF, а совпавший текст не переписывается', async () => {
		const fileService = createFileService();
		const writes: string[] = [];
		disposables.add(fileService.onDidRunOperation(e => {
			if (e.operation === FileOperation.WRITE && e.resource.path.endsWith(`/seedBase/${PATH}`)) {
				writes.push(e.resource.path);
			}
		}));
		await recordSeedBases(fileService, VIBE_DIR, [{ path: PATH, contents: 'раз\r\nдва\r\n' }]);
		await recordSeedBases(fileService, VIBE_DIR, [{ path: PATH, contents: 'раз\nдва\n' }]);
		assert.deepStrictEqual({ stored: await readSeedBase(fileService, VIBE_DIR, PATH), writes: writes.length }, { stored: 'раз\nдва\n', writes: 1 });
	});

	test('копия, равная релизу, и нетронутая копия прошлой ревизии получают основу; правленая — нет', async () => {
		const fileService = createFileService();
		const known = await revisions();

		// равна релизу → основа = релиз
		await write(fileService, PATH, release);
		await refreshSeedBases(fileService, VIBE_DIR, await diffVibeDefaults(fileService, VIBE_DIR, known));
		const afterSame = await readSeedBase(fileService, VIBE_DIR, PATH);

		// нетронутая прошлая ревизия → основа = её текст (он и есть ревизия, от которой засеяно)
		const other = createFileService();
		await write(other, PATH, past);
		await refreshSeedBases(other, VIBE_DIR, await diffVibeDefaults(other, VIBE_DIR, known));
		const afterOutdated = await readSeedBase(other, VIBE_DIR, PATH);

		// правка человека → выдумывать основу не из чего
		const edited = createFileService();
		await write(edited, PATH, mine);
		await refreshSeedBases(edited, VIBE_DIR, await diffVibeDefaults(edited, VIBE_DIR, known));
		const afterEdited = await readSeedBase(edited, VIBE_DIR, PATH);

		assert.deepStrictEqual([afterSame, afterOutdated, afterEdited], [release, past, undefined]);
	});

	test('своё решение при следующем сдвиге набора — конфликт, а не «обновить безопасно» (иначе правки пропадут)', async () => {
		const fileService = createFileService();
		const known = await revisions();
		// Человек оставил свой файл против прошлой ревизии; набор ушёл дальше, файл с тех пор не менялся
		await write(fileService, PATH, mine);
		await writeLock(fileService, { release: lockSha(past), local: lockSha(mine) });
		const statusOf = async () => (await diffVibeDefaults(fileService, VIBE_DIR, known)).entries.find(e => e.path === PATH)?.status;
		const kept = await statusOf();

		// Контроль: файл был равен прошлой ревизии на точке сверки — обновлять безопасно, как и раньше
		await write(fileService, PATH, past);
		await writeLock(fileService, { release: lockSha(past), local: lockSha(past) });
		const untouched = await statusOf();

		// Контроль: набор не сдвигался — свой файл молчит
		await write(fileService, PATH, mine);
		await writeLock(fileService, { release: lockSha(release), local: lockSha(mine) });
		const quiet = await statusOf();

		assert.deepStrictEqual([kept, untouched, quiet], ['conflict', 'outdated', 'customized']);
	});

	test('план слияния: основа есть — три стороны, нет — сравнение двух, середину никто не выдумывает', () => {
		const entries = [{ path: 'rules/a.mdc' }, { path: 'rules/b.mdc' }, { path: 'rules/c.mdc' }];
		const plan = planSeedMerge(entries, new Set(['rules/b.mdc']));
		assert.deepStrictEqual(
			{ threeWay: plan.threeWay.map(e => e.path), twoWay: plan.twoWay.map(e => e.path) },
			{ threeWay: ['rules/b.mdc'], twoWay: ['rules/a.mdc', 'rules/c.mdc'] },
		);
	});

	test('какие основы есть — читается по файлам, а путь основы вложен в local/seedBase', async () => {
		const fileService = createFileService();
		await recordSeedBases(fileService, VIBE_DIR, [{ path: 'rules/b.mdc', contents: 'б' }]);
		assert.deepStrictEqual(
			{
				present: [...await seedBasesPresent(fileService, VIBE_DIR, ['rules/a.mdc', 'rules/b.mdc'])],
				where: seedBaseUri(VIBE_DIR, 'rules/b.mdc').path,
			},
			{ present: ['rules/b.mdc'], where: '/ws/.vibe/local/seedBase/rules/b.mdc' },
		);
	});
});
