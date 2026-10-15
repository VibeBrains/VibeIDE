/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { ACP_CONTEXT_MAX_TABS, AcpContextItem, IAcpPromptInput, buildAcpPromptBlocks } from '../../common/acp/acpPromptContext.js';
import { IAcpPromptCapabilities } from '../../common/acp/acpProtocol.js';
import { detectSecrets } from '../../common/secretDetection.js';

suite('acpPromptContext', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	const embeds: IAcpPromptCapabilities = { image: true, audio: false, embeddedContext: true };
	const linksOnly: IAcpPromptCapabilities = { image: false, audio: false, embeddedContext: false };

	/** The real redaction, not a stub: a mask that stopped matching would let a key through the tests as well */
	const redact = (text: string) => detectSecrets(text).redactedText;

	const input = (overrides: Partial<IAcpPromptInput> = {}): IAcpPromptInput => ({
		text: 'изучи открытый файл',
		commands: [],
		capabilities: embeds,
		embedMaxChars: 1000,
		items: [],
		redact,
		...overrides,
	});

	const KEY = 'sk-abcdefghijklmnopqrstuvwxyz0123';

	suite('подсказка о редакторе', () => {
		test('активный файл и вкладки идут первым блоком, слова человека — вторым', () => {
			const blocks = buildAcpPromptBlocks(input({ editor: { activeFile: '/app/a.ts', openFiles: ['/app/a.ts', '/app/b.ts'] } }));
			assert.deepStrictEqual(blocks, [
				{ type: 'text', text: '<ide_context>\nThe editor at the moment this message was written:\n- Active file: /app/a.ts\n- Open tabs:\n/app/a.ts\n/app/b.ts\n</ide_context>' },
				{ type: 'text', text: 'изучи открытый файл' },
			]);
		});

		test('пустой редактор подсказки не даёт', () => {
			assert.deepStrictEqual(buildAcpPromptBlocks(input({ editor: { openFiles: [] } })), [{ type: 'text', text: 'изучи открытый файл' }]);
		});

		test('вкладок больше предела — лишние считаются, а не перечисляются', () => {
			const openFiles = Array.from({ length: ACP_CONTEXT_MAX_TABS + 3 }, (_, i) => `/app/f${i}.ts`);
			const hint = (buildAcpPromptBlocks(input({ editor: { activeFile: '/app/f0.ts', openFiles } }))[0] as { text: string }).text;
			assert.deepStrictEqual([hint.includes(`/app/f${ACP_CONTEXT_MAX_TABS - 1}.ts`), hint.includes(`/app/f${ACP_CONTEXT_MAX_TABS}.ts`), hint.includes('... and 3 more')], [true, false, true]);
		});

		test('закрытый .vibe/ignore файл не называется ни активным, ни вкладкой', () => {
			const blocks = buildAcpPromptBlocks(input({
				editor: { activeFile: '/app/.env', openFiles: ['/app/.env', '/app/a.ts'] },
				isHidden: path => path.endsWith('.env'),
			}));
			const hint = (blocks[0] as { text: string }).text;
			assert.deepStrictEqual([hint.includes('.env'), hint.includes('- Active file: none'), hint.includes('/app/a.ts')], [false, true, true]);
		});
	});

	suite('команда агента', () => {
		test('задача, начатая командой агента, уходит как есть — без подсказки, заметки и вложений', () => {
			const blocks = buildAcpPromptBlocks(input({
				text: '/review src',
				note: 'Пиши коротко',
				commands: [{ name: 'review', description: '' }],
				editor: { activeFile: '/app/a.ts', openFiles: ['/app/a.ts'] },
				items: [{ kind: 'file', path: '/app/a.ts', text: 'x' }],
			}));
			assert.deepStrictEqual(blocks, [{ type: 'text', text: '/review src' }]);
		});

		test('слово с косой, которого агент не объявил, — обычная задача', () => {
			const blocks = buildAcpPromptBlocks(input({ text: '/unknown x', commands: [{ name: 'review', description: '' }], note: 'Коротко' }));
			assert.deepStrictEqual(blocks, [{ type: 'text', text: 'Коротко\n\n/unknown x' }]);
		});
	});

	suite('выделение', () => {
		const selection: AcpContextItem = { kind: 'selection', path: '/app/a.ts', startLine: 3, endLine: 5, text: 'const x = 1;' };

		test('агенту со встроенным содержимым — resource с диапазоном строк в адресе', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [selection] }));
			assert.deepStrictEqual(blocks[1], { type: 'resource', resource: { uri: 'file:///app/a.ts#L3-5', text: 'const x = 1;' } });
		});

		test('агенту без встроенного содержимого — текстом: выделение не сводится к ссылке', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [selection], capabilities: linksOnly }));
			assert.deepStrictEqual(blocks[1], { type: 'text', text: 'Selection in /app/a.ts (lines 3-5):\n```\nconst x = 1;\n```' });
		});

		test('выделение длиннее предела — ссылкой на диапазон', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [{ ...selection, text: 'y'.repeat(1001) }] }));
			assert.deepStrictEqual(blocks[1], { type: 'resource_link', uri: 'file:///app/a.ts#L3-5', name: 'a.ts:3-5' });
		});

		test('ключ в выделении маскируется — и во встроенном, и в текстовом виде', () => {
			const secret: AcpContextItem = { ...selection, text: `const key = '${KEY}';` };
			const embedded = buildAcpPromptBlocks(input({ items: [secret] }))[1] as { resource: { text: string } };
			const inline = buildAcpPromptBlocks(input({ items: [secret], capabilities: linksOnly }))[1] as { text: string };
			assert.deepStrictEqual([embedded.resource.text.includes(KEY), inline.text.includes(KEY), embedded.resource.text.includes('REDACTED')], [false, false, true]);
		});
	});

	suite('файл и папка', () => {
		test('файл меньше предела уходит текстом, больше — ссылкой', () => {
			const small: AcpContextItem = { kind: 'file', path: '/app/small.ts', text: 'ok' };
			const large: AcpContextItem = { kind: 'file', path: '/app/large.ts', text: 'z'.repeat(1001) };
			const blocks = buildAcpPromptBlocks(input({ items: [small, large] }));
			assert.deepStrictEqual(blocks.slice(1), [
				{ type: 'resource', resource: { uri: 'file:///app/small.ts', text: 'ok' } },
				{ type: 'resource_link', uri: 'file:///app/large.ts', name: 'large.ts' },
			]);
		});

		test('файл, предел которого ровно в размер, ещё встраивается', () => {
			const exact: AcpContextItem = { kind: 'file', path: '/app/exact.ts', text: 'q'.repeat(1000) };
			assert.strictEqual(buildAcpPromptBlocks(input({ items: [exact] }))[1].type, 'resource');
		});

		test('агент без встроенного содержимого получает ссылку — её требует спецификация от каждого', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [{ kind: 'file', path: '/app/a.ts', text: 'ok' }], capabilities: linksOnly }));
			assert.deepStrictEqual(blocks[1], { type: 'resource_link', uri: 'file:///app/a.ts', name: 'a.ts' });
		});

		test('нечитаемый файл — ссылкой, ключ внутри встроенного — замаскирован', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [
				{ kind: 'file', path: '/app/img.png' },
				{ kind: 'file', path: '/app/config.ts', text: `export const token = '${KEY}';` },
			] }));
			const embedded = blocks[2] as { resource: { text: string } };
			assert.deepStrictEqual([blocks[1].type, embedded.resource.text.includes(KEY), embedded.resource.text.includes('REDACTED')], ['resource_link', false, true]);
		});

		test('папка — ссылкой с косой в имени; закрытый файл не попадает вовсе', () => {
			const blocks = buildAcpPromptBlocks(input({
				items: [{ kind: 'folder', path: '/app/src' }, { kind: 'file', path: '/app/.env', text: `K=${KEY}` }],
				isHidden: path => path.endsWith('.env'),
			}));
			assert.deepStrictEqual(blocks.slice(1), [{ type: 'resource_link', uri: 'file:///app/src', name: 'src/' }]);
		});

		test('путь с пробелами и не-ASCII кодируется в адресе', () => {
			const blocks = buildAcpPromptBlocks(input({ items: [{ kind: 'file', path: '/app/мой файл.ts' }] }));
			assert.deepStrictEqual(blocks[1], { type: 'resource_link', uri: 'file:///app/%D0%BC%D0%BE%D0%B9%20%D1%84%D0%B0%D0%B9%D0%BB.ts', name: 'мой файл.ts' });
		});
	});

	test('заметка про стиль ответов идёт перед словами человека в одном блоке', () => {
		assert.deepStrictEqual(buildAcpPromptBlocks(input({ note: 'Коротко', text: 'сделай' })), [{ type: 'text', text: 'Коротко\n\nсделай' }]);
	});
});
