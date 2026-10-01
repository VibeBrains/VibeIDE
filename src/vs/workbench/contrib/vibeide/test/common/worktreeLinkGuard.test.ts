/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { packageInstallSegment } from '../../common/worktreeLinkGuard.js';
import { isInsideRoot } from '../../common/worktreeRebase.js';

suite('worktreeLinkGuard — общие папки в дереве роли', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('установка пакетов узнаётся в любой части команды и за обёртками', () => {
		assert.deepStrictEqual({
			npmCi: packageInstallSegment('npm ci'),
			npmI: packageInstallSegment('npm i -D typescript'),
			pnpmAdd: packageInstallSegment('pnpm add zod'),
			yarnГолый: packageInstallSegment('yarn'),
			yarnФлаги: packageInstallSegment('yarn --frozen-lockfile'),
			bunInstall: packageInstallSegment('bun install'),
			вЦепочке: packageInstallSegment('npm run lint && npm install left-pad'),
			заПеременной: packageInstallSegment('CI=1 npm ci'),
			заОбёрткой: packageInstallSegment('corepack pnpm install'),
			путьИРасширение: packageInstallSegment('C:\\tools\\npm.cmd install'),
		}, {
			npmCi: 'npm ci',
			npmI: 'npm i -D typescript',
			pnpmAdd: 'pnpm add zod',
			yarnГолый: 'yarn',
			yarnФлаги: 'yarn --frozen-lockfile',
			bunInstall: 'bun install',
			вЦепочке: 'npm install left-pad',
			заПеременной: 'CI=1 npm ci',
			заОбёрткой: 'corepack pnpm install',
			путьИРасширение: 'C:\\tools\\npm.cmd install',
		});
	});

	test('сборка, тесты и запуск скриптов не трогают зависимости и проходят', () => {
		assert.deepStrictEqual([
			packageInstallSegment('npm test'),
			packageInstallSegment('npm run install-hooks'),
			packageInstallSegment('yarn build'),
			packageInstallSegment('pnpm exec tsc --noEmit'),
			packageInstallSegment('npx tsc -p .'),
			packageInstallSegment('echo npm install'),
		], [undefined, undefined, undefined, undefined, undefined, undefined]);
	});

	test('запись сквозь ссылку: настоящий путь цели вне настоящего корня дерева', () => {
		const tree = '/repo/.vibe-worktrees/vibe-agent-1';
		assert.deepStrictEqual({
			вДереве: isInsideRoot(tree, `${tree}/src/app.ts`),
			поСсылкеВОбщуюПапку: isInsideRoot(tree, '/repo/node_modules/pkg/index.js'),
			соседнееДеревоСПрефиксом: isInsideRoot(tree, '/repo/.vibe-worktrees/vibe-agent-10/a.ts'),
			регистрWindows: isInsideRoot('C:\\Repo\\.vibe-worktrees\\t', 'c:/repo/.vibe-worktrees/t/a.ts', true),
		}, {
			вДереве: true,
			поСсылкеВОбщуюПапку: false,
			соседнееДеревоСПрефиксом: false,
			регистрWindows: true,
		});
	});
});
