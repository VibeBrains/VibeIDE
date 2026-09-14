/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { isWindows } from '../../../../../base/common/platform.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PhysicalPath, PhysicalPathProbe, placePhysicalPath, resolvePhysicalEntry, resolvePhysicalPath } from '../../common/agentPhysicalPath.js';

/**
 * A tiny filesystem: real paths, symlinks (link → target) and dangling links.
 * `realpath` follows links component by component, the way the OS does.
 */
function fakeFs(real: readonly string[], links: Readonly<Record<string, string>> = {}, dangling: readonly string[] = []): PhysicalPathProbe {
	const resolve = (path: string): string | undefined => {
		const parts = path.split('/').filter(Boolean);
		let acc = '';
		for (const part of parts) {
			acc = `${acc}/${part}`;
			for (let hops = 0; links[acc] !== undefined; hops++) {
				if (hops > 40) { return undefined; }
				acc = links[acc];
			}
			if (!real.includes(acc)) { return undefined; }
		}
		return acc || '/';
	};
	return {
		async exists(uri) {
			return uri.path === '/' || dangling.includes(uri.path) || resolve(uri.path) !== undefined;
		},
		async realpath(uri) {
			if (dangling.includes(uri.path)) { throw new Error('ENOENT'); }
			const r = resolve(uri.path);
			if (r === undefined) { throw new Error('ENOENT'); }
			return URI.file(r);
		},
	};
}

const show = (p: PhysicalPath) => p.kind === 'resolved' ? p.uri.path : p.kind === 'unresolvable' ? `нельзя развернуть: ${p.at.path}` : 'не поддерживается';

(isWindows ? suite.skip : suite)('физический путь агента', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	const real = ['/ws', '/ws/src', '/ws/src/a.ts', '/outside', '/outside/secret.txt'];

	test('без симлинков путь остаётся собой, в том числе ещё не созданный', async () => {
		const fs = fakeFs(real);
		assert.deepStrictEqual({
			существующий: show(await resolvePhysicalPath(URI.file('/ws/src/a.ts'), fs)),
			новый: show(await resolvePhysicalPath(URI.file('/ws/src/new/deep/b.ts'), fs)),
		}, { существующий: '/ws/src/a.ts', новый: '/ws/src/new/deep/b.ts' });
	});

	/** The escape a lexical rule cannot see: a link inside the workspace pointing outside it. */
	test('симлинк внутри проекта, ведущий наружу, разворачивается наружу', async () => {
		const fs = fakeFs(real, { '/ws/link': '/outside' });
		assert.deepStrictEqual({
			существующий: show(await resolvePhysicalPath(URI.file('/ws/link/secret.txt'), fs)),
			новый: show(await resolvePhysicalPath(URI.file('/ws/link/new.txt'), fs)),
		}, { существующий: '/outside/secret.txt', новый: '/outside/new.txt' });
	});

	/**
	 * `exists()` answers yes for a dangling link and `realpath` fails — and a write through it would
	 * create the file on the far side. «Nothing to resolve» would wave exactly that through.
	 */
	test('висячий симлинк — не «нечего разворачивать», а отказ', async () => {
		const fs = fakeFs(real, {}, ['/ws/evil']);
		assert.strictEqual(show(await resolvePhysicalPath(URI.file('/ws/evil'), fs)), 'нельзя развернуть: /ws/evil');
	});

	/** On this machine `/Users/…/Projects` is a symlink to another volume — the root itself is a link. */
	test('корень проекта сам через симлинк разворачивается целиком', async () => {
		const fs = fakeFs(['/vol', '/vol/proj', '/vol/proj/src'], { '/home': '/vol' });
		assert.strictEqual(show(await resolvePhysicalPath(URI.file('/home/proj/src/c.ts'), fs)), '/vol/proj/src/c.ts');
	});

	test('файловая система без симлинков честно говорит, что развернуть нечем', async () => {
		const noLinks: PhysicalPathProbe = { async exists() { return true; }, async realpath() { return undefined; } };
		assert.strictEqual(show(await resolvePhysicalPath(URI.file('/ws/a'), noLinks)), 'не поддерживается');
	});

	/** Deleting a link removes the link: the folder it sits in must be inside, not what it points at. */
	test('удаляется запись, а не цель ссылки', async () => {
		const fs = fakeFs(real, { '/ws/link': '/outside', '/ws/linkdir': '/outside' });
		assert.deepStrictEqual({
			самаСсылка: show(await resolvePhysicalEntry(URI.file('/ws/link'), fs)),
			внутриСсылки: show(await resolvePhysicalEntry(URI.file('/ws/linkdir/secret.txt'), fs)),
		}, { самаСсылка: '/ws/link', внутриСсылки: '/outside/secret.txt' });
	});

	suite('место относительно корней', () => {
		const root = (seen: string, real = seen) => ({ seen: URI.file(seen), real: URI.file(real) });
		const place = (physical: string, roots: ReturnType<typeof root>[]) => {
			const placed = placePhysicalPath(URI.file(physical), roots);
			return { inside: placed.inside, seen: placed.seen.path };
		};

		/**
		 * The owner's machine: `~/Projects` is a link to another volume, so every file resolves there.
		 * Compared with the resolved root it is inside, and it is named the way the workspace names it.
		 */
		test('корень через симлинк: файл внутри и назван как в проекте', () => {
			assert.deepStrictEqual(
				place('/Volumes/Storage/Projects/app/src/a.ts', [root('/Users/me/Projects/app', '/Volumes/Storage/Projects/app')]),
				{ inside: true, seen: '/Users/me/Projects/app/src/a.ts' },
			);
		});

		test('вне всех корней — снаружи и под своим физическим именем', () => {
			assert.deepStrictEqual(place('/outside/secret.txt', [root('/ws')]), { inside: false, seen: '/outside/secret.txt' });
		});

		/** Nested roots: the inner folder is the one that describes the file, so the deepest root wins. */
		test('из вложенных корней выбирается самый глубокий', () => {
			assert.deepStrictEqual(
				place('/real/mono/pkg/x.ts', [root('/w/mono', '/real/mono'), root('/w/pkg', '/real/mono/pkg')]),
				{ inside: true, seen: '/w/pkg/x.ts' },
			);
		});

		/** A shared prefix is not a folder boundary: `/ws-evil` is not under `/ws`. */
		test('сам корень внутри, соседняя папка с общим префиксом — снаружи', () => {
			assert.deepStrictEqual({
				корень: place('/real/app', [root('/w/app', '/real/app')]),
				сосед: place('/ws-evil/x', [root('/ws')]).inside,
			}, { корень: { inside: true, seen: '/w/app' }, сосед: false });
		});
	});
});
