/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { VibeAcpEditReviewService, IVibeAcpEditCall } from '../../browser/acp/vibeAcpEditReview.js';
import { ExternalEditOpts } from '../../browser/editCodeServiceInterface.js';

/**
 * Правка внешнего агента встаёт на общий разбор: зона файла получает прежний текст, «Отклонить» возвращает его
 * Службы вокруг — подставные; проверяется порядок действий и решение о том, что ставить на разбор
 */
suite('VibeAcpEditReviewService — правки внешнего агента на разборе', () => {

	const disposables = ensureNoDisposablesAreLeakedInTestSuite();

	const path = '/ws/app/src/a.ts';
	const fsPathOf = (p: string) => URI.file(p).fsPath;

	function setup(disk: Record<string, string> = {}, options: { failFirstRegister?: boolean } = {}) {
		let failNext = options.failFirstRegister === true;
		const steps: string[] = [];
		const registered: ExternalEditOpts[] = [];
		const errors: string[] = [];
		const dirty = new Set<string>();
		const files = new Map(Object.entries(disk).map(([key, value]) => [fsPathOf(key), value]));
		const service = disposables.add(new VibeAcpEditReviewService(
			{
				registerExternalEdit: (opts: ExternalEditOpts) => {
					if (failNext) { failNext = false; throw new Error('сбой зоны'); }
					steps.push('register');
					registered.push(opts);
					return true;
				},
			} as never,
			{
				isDirty: (uri: URI) => dirty.has(uri.fsPath),
				read: async (uri: URI) => {
					const value = files.get(uri.fsPath);
					if (value === undefined) { throw new Error('нет файла'); }
					return { value };
				},
				files: { resolve: async () => { steps.push('reload'); } },
			} as never,
			{
				invalidateExistenceCache: () => { steps.push('forget-existence'); },
				initializeModel: async () => { steps.push('model'); },
				saveModel: async () => { steps.push('save'); },
			} as never,
			{ hasCapability: () => true, del: async (_uri: URI, options: { useTrash: boolean }) => { steps.push(`del trash=${options.useTrash}`); } } as never,
			{ getWorkspaceFolder: (uri: URI) => uri.fsPath.startsWith(fsPathOf('/ws/app')) ? { uri: URI.file('/ws/app') } : null } as never,
			{ logError: (text: string) => { errors.push(text); } } as never,
		));
		return { service, steps, registered, errors, dirty, files };
	}

	const edit = (overrides: Partial<IVibeAcpEditCall> = {}): IVibeAcpEditCall => ({
		toolKind: 'edit', status: 'completed', paths: [path], diffs: [{ path, oldText: 'return 1;', newText: 'return 2;' }], ...overrides,
	});
	const before = (text: string | null, p = path) => text === null ? { path: p, state: 'absent' as const } : { path: p, state: 'text' as const, text };

	test('завершённая правка встаёт на разбор против текста до хода, модель сперва догоняет диск', async () => {
		const { service, steps, registered } = setup({ [path]: 'return 2;\n' });
		service.beginTurn('s1');
		service.remember('s1', [before('return 1;\n')]);
		await service.settle('s1', edit());
		assert.deepStrictEqual([steps, registered.map(opts => [opts.uri.fsPath, opts.originalCode, opts.onRejected !== undefined])], [
			['forget-existence', 'model', 'reload', 'register'],
			[[fsPathOf(path), 'return 1;\n', false]],
		]);
	});

	test('вызов, который не правка или ещё не закончился, на разбор не идёт', async () => {
		const { service, registered } = setup({ [path]: 'return 2;\n' });
		service.remember('s1', [before('return 1;\n')]);
		await service.settle('s1', edit({ toolKind: 'execute' }));
		await service.settle('s1', edit({ status: 'in_progress' }));
		await service.settle('s1', edit({ status: 'failed' }));
		assert.deepStrictEqual(registered, []);
	});

	test('файл вне проекта на разбор не идёт', async () => {
		const outside = '/etc/hosts';
		const { service, registered } = setup({ [outside]: 'x' });
		service.remember('s1', [before('y', outside)]);
		await service.settle('s1', edit({ paths: [outside], diffs: [] }));
		assert.deepStrictEqual(registered, []);
	});

	test('несохранённые правки человека: на разбор не идёт, причина названа', async () => {
		const { service, registered, errors, dirty } = setup({ [path]: 'return 2;\n' });
		dirty.add(fsPathOf(path));
		service.remember('s1', [before('return 1;\n')]);
		await service.settle('s1', edit());
		assert.deepStrictEqual([registered, errors.length, errors[0]?.includes('несохранённые')], [[], 1, true]);
	});

	test('созданный файл: база пуста, отклонение сперва дожидается сохранения отката, затем убирает файл в корзину', async () => {
		const { service, steps, registered } = setup({ [path]: 'новый\n' });
		service.remember('s1', [before(null)]);
		await service.settle('s1', edit({ diffs: [{ path, oldText: '', newText: 'новый\n' }] }));
		assert.strictEqual(registered[0].originalCode, '');
		steps.length = 0;
		registered[0].onRejected?.();
		await new Promise(resolve => setTimeout(resolve, 0));
		assert.deepStrictEqual(steps, ['save', 'del trash=true', 'forget-existence']);
	});

	test('вызов успел записать файл раньше, чем его прочли: база восстановлена по диффу', async () => {
		const { service, registered } = setup({ [path]: 'function f() {\n\treturn 2;\n}\n' });
		service.remember('s1', [before('function f() {\n\treturn 2;\n}\n')]);
		await service.settle('s1', edit());
		assert.deepStrictEqual(registered.map(opts => opts.originalCode), ['function f() {\n\treturn 1;\n}\n']);
	});

	test('базы нет, а дифф — запись файла целиком: на разбор не идёт, угаданная база опустошила бы файл', async () => {
		const { service, registered } = setup({ [path]: 'всё\n' });
		await service.settle('s1', edit({ diffs: [{ path, oldText: '', newText: 'всё\n' }] }));
		assert.deepStrictEqual(registered, []);
	});

	test('две правки одного файла за ход держатся за базу начала хода', async () => {
		const { service, registered, files } = setup({ [path]: 'a\nB\n' });
		service.remember('s1', [before('a\nb\n')]);
		await service.settle('s1', edit({ diffs: [{ path, oldText: 'b', newText: 'B' }] }));
		// Вторая правка: главный процесс не читает файл повторно, база та же
		files.set(fsPathOf(path), 'a\nB\nC\n');
		service.remember('s1', [before('a\nB\n')]);
		await service.settle('s1', edit({ diffs: [{ path, oldText: 'B', newText: 'B\nC' }] }));
		assert.deepStrictEqual(registered.map(opts => opts.originalCode), ['a\nb\n', 'a\nb\n']);
	});

	test('новый ход забывает базы прежнего: файл снова снимается с нуля', async () => {
		const { service, registered } = setup({ [path]: 'return 2;\n' });
		service.remember('s1', [before('return 1;\n')]);
		service.beginTurn('s1');
		await service.settle('s1', edit({ diffs: [] }));
		assert.deepStrictEqual(registered, []);
	});

	test('сессия закончилась — её базы забыты', async () => {
		const { service, registered } = setup({ [path]: 'return 2;\n' });
		service.remember('s1', [before('return 1;\n')]);
		service.forget('s1');
		await service.settle('s1', edit({ diffs: [] }));
		assert.deepStrictEqual(registered, []);
	});

	test('файл, записанный агентом через нас, встаёт на разбор против снятого перед записью текста', async () => {
		const { service, registered } = setup({ [path]: 'после\n' });
		service.remember('s1', [before('до\n')]);
		await service.settleWritten('s1', path);
		assert.deepStrictEqual(registered.map(opts => opts.originalCode), ['до\n']);
	});

	test('сбой одной правки очередь не останавливает', async () => {
		const { service, registered, errors } = setup({ [path]: 'return 2;\n', ['/ws/app/src/b.ts']: 'b2\n' }, { failFirstRegister: true });
		service.remember('s1', [before('return 1;\n'), before('b1\n', '/ws/app/src/b.ts')]);
		await service.settle('s1', edit());
		await service.settle('s1', edit({ paths: ['/ws/app/src/b.ts'], diffs: [] }));
		assert.deepStrictEqual([registered.map(opts => opts.originalCode), errors.length], [['b1\n'], 1]);
	});
});
