/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

// Документ хрома встроенного браузера держит границу между воркбенчем и страницей превью.
// Страница шлёт хрому сообщения тем же `postMessage`, что и сам хост веб-вью, — разделяет их только источник.
// Скрипт хрома здесь исполняется на подставных окнах, и проверяется, какие сообщения он пропускает дальше.

import * as assert from 'assert';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { PREVIEW_FRAME_SANDBOX } from '../../common/vibeServer/previewBridgePolicy.js';
import { buildPreviewChromeHtml } from '../../common/vibeServer/previewChromeHtml.js';

type Listener = (event: { data: unknown; source: unknown }) => void;

interface FakeElement {
	src?: string;
	disabled?: boolean;
	hidden?: boolean;
	value?: string;
	className?: string;
	contentWindow?: FakeWindow;
	style: Record<string, string>;
	classList: { toggle(): void };
	addEventListener(type: string, listener: Listener): void;
}

interface FakeWindow {
	readonly name: string;
	readonly sent: unknown[];
	postMessage(message: unknown): void;
}

const ORIGIN = 'http://localhost:5173';

function fakeWindow(name: string): FakeWindow {
	const sent: unknown[] = [];
	return { name, sent, postMessage: message => { sent.push(message); } };
}

/** Исполняет скрипт хрома на подставном окружении; возвращает то, что от него наблюдает хост и рамка. */
function runChrome() {
	const html = buildPreviewChromeHtml(`${ORIGIN}/index.html`, true, 'test-nonce');
	const script = /<script nonce="test-nonce">([\s\S]*)<\/script>/.exec(html)![1];

	const frameWindow = fakeWindow('frame');
	const parentWindow = fakeWindow('parent');
	const nestedWindow = fakeWindow('nested-in-page');
	const elements = new Map<string, FakeElement>();
	const element = (id: string): FakeElement => {
		let existing = elements.get(id);
		if (!existing) {
			existing = { style: {}, classList: { toggle() { } }, addEventListener() { } };
			if (id === 'vb-frame') {
				existing.contentWindow = frameWindow;
				existing.src = `${ORIGIN}/index.html`;
			}
			elements.set(id, existing);
		}
		return existing;
	};

	const toHost: unknown[] = [];
	let onMessage: Listener | undefined;
	const fakeDocument = { getElementById: element };
	const fakeGlobalWindow = {
		parent: parentWindow,
		addEventListener: (type: string, listener: Listener) => { if (type === 'message') { onMessage = listener; } },
	};
	new Function('acquireVsCodeApi', 'document', 'window', 'requestAnimationFrame', 'setTimeout', script)(
		() => ({ postMessage: (message: unknown) => { toHost.push(message); } }),
		fakeDocument,
		fakeGlobalWindow,
		(callback: () => void) => callback(),
		() => 0,
	);
	return {
		html,
		frame: element('vb-frame'),
		frameWindow, parentWindow, nestedWindow,
		toHost,
		send: (source: FakeWindow, data: unknown) => onMessage!({ data, source }),
	};
}

suite('previewChromeHtml — граница между воркбенчем и страницей превью', () => {

	ensureNoDisposablesAreLeakedInTestSuite();

	test('собранный скрипт — синтаксически валидный JavaScript и вешает слушатель сообщений', () => {
		const chrome = runChrome();
		assert.doesNotThrow(() => chrome.send(chrome.frameWindow, null));
	});

	test('рамка получает песочницу без ухода хрома на другой адрес, окон и диалогов; CSP пускает только origin превью', () => {
		const { html } = runChrome();
		assert.deepStrictEqual(
			{
				sandbox: /<iframe id="vb-frame" sandbox="([^"]*)"/.exec(html)?.[1],
				frameSrc: /frame-src ([^;"]+)/.exec(html)?.[1],
			},
			{ sandbox: PREVIEW_FRAME_SANDBOX, frameSrc: ORIGIN },
		);
	});

	test('сообщения моста от самой рамки доходят до хоста', () => {
		const chrome = runChrome();
		chrome.send(chrome.frameWindow, { __vibeBrowser: 'console', level: 'error', text: 'boom' });
		chrome.send(chrome.frameWindow, { __vibeBrowser: 'external', href: 'https://example.com/' });
		chrome.send(chrome.frameWindow, { __vibeBrowser: 'inspect', selector: 'div > p', html: '<p>', href: `${ORIGIN}/`, path: '/' });
		assert.deepStrictEqual(chrome.toHost, [
			{ type: 'console', level: 'error', text: 'boom' },
			{ type: 'open-external', href: 'https://example.com/' },
			{ type: 'inspect', selector: 'div > p', html: '<p>', href: `${ORIGIN}/`, path: '/' },
		]);
	});

	test('сообщение моста от окна, вложенного в страницу (реклама, виджет), хрому не передаётся', () => {
		const chrome = runChrome();
		chrome.send(chrome.nestedWindow, { __vibeBrowser: 'external', href: 'file:///etc/passwd' });
		chrome.send(chrome.nestedWindow, { __vibeBrowser: 'console', level: 'error', text: 'подделка' });
		assert.deepStrictEqual(chrome.toHost, []);
	});

	test('страница не может отдать себе команды хрома: navigate, design-overlay, scroll-to и остальное от рамки глухи', () => {
		const chrome = runChrome();
		const before = chrome.frame.src;
		chrome.send(chrome.frameWindow, { type: 'navigate', url: 'https://evil.example/' });
		chrome.send(chrome.frameWindow, { type: 'reload' });
		chrome.send(chrome.frameWindow, { type: 'design-overlay', items: [{ selector: 'a', rule: 'x', severity: 'high' }] });
		chrome.send(chrome.frameWindow, { type: 'inspect-supported', value: true });
		chrome.send(chrome.frameWindow, { type: 'scroll-to', x: 1, y: 2 });
		assert.deepStrictEqual({ src: chrome.frame.src, toFrame: chrome.frameWindow.sent, toHost: chrome.toHost }, { src: before, toFrame: [], toHost: [] });
	});

	test('команды хоста принимаются только от родительского окна веб-вью, не от постороннего', () => {
		const chrome = runChrome();
		chrome.send(chrome.nestedWindow, { type: 'navigate', url: '/from-nested' });
		const afterNested = chrome.frame.src;
		chrome.send(chrome.parentWindow, { type: 'navigate', url: '/from-host' });
		assert.deepStrictEqual([afterNested, chrome.frame.src], [`${ORIGIN}/index.html`, `${ORIGIN}/from-host`]);
	});

	test('переход по команде хоста проходит нормализацию: чужая схема не попадает в src рамки', () => {
		const chrome = runChrome();
		const navigated = (url: string) => {
			chrome.send(chrome.parentWindow, { type: 'navigate', url });
			return chrome.frame.src;
		};
		assert.deepStrictEqual(
			[navigated('javascript:alert(1)'), navigated('file:///etc/passwd'), navigated('/about'), navigated('https://dev.example/x')],
			[`${ORIGIN}/javascript:alert(1)`, `${ORIGIN}/file:///etc/passwd`, `${ORIGIN}/about`, 'https://dev.example/x'],
		);
	});

	test('адрес страницы в `nav` принимается только с origin вкладки: иначе адресная строка показала бы чужой сайт', () => {
		const chrome = runChrome();
		for (const href of ['javascript:alert(1)', 'https://evil.example/', `${ORIGIN}.evil.example/`, { toString: () => ORIGIN }]) {
			chrome.send(chrome.frameWindow, { __vibeBrowser: 'nav', href, title: 'подделка' });
		}
		chrome.send(chrome.frameWindow, { __vibeBrowser: 'nav', href: `${ORIGIN}/ok`, title: 'Ok' });
		assert.deepStrictEqual(chrome.toHost, [{ type: 'navigated', href: `${ORIGIN}/ok`, title: 'Ok' }]);
	});

	test('адрес превью экранируется в атрибуте и в скрипте: кавычка и закрывающий тег не выводят из них', () => {
		const html = buildPreviewChromeHtml(`${ORIGIN}/a"onload="x</script><b>`, true, 'n');
		const iframe = /<iframe[^>]*>/.exec(html)![0];
		assert.deepStrictEqual(
			{ attributeClosedEarly: /onload="x/.test(iframe), tagInAttribute: iframe.includes('</script>'), tagInScript: /var ORIGIN = [^\n]*<\/script>/.test(html) || /addr\.value = [^\n]*<\/script>/.test(html) },
			{ attributeClosedEarly: false, tagInAttribute: false, tagInScript: false },
		);
	});
});
