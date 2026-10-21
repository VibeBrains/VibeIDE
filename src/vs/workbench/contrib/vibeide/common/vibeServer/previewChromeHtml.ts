/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

/**
 * Документ хрома встроенного браузера: адресная строка, кнопки, рамка с превью и скрипт, который связывает
 * рамку с воркбенчем через `postMessage`.
 *
 * Вынесен из `vibeBrowserManager.ts` в чистую функцию, чтобы границу доверия можно было проверить без веб-вью:
 * тест исполняет скрипт на подставных окнах и смотрит, какие сообщения он пропускает (`previewChromeHtml.test.ts`).
 *
 * Адрес должен быть уже проверен (`webUrlOf`): здесь он только экранируется.
 */

import { PREVIEW_FRAME_SANDBOX } from './previewBridgePolicy.js';

/** Значение атрибута HTML в двойных кавычках: адрес с `"` или `<` не должен выходить из атрибута. */
function escapeHtmlAttribute(value: string): string {
	return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

/** JSON для вставки в `<script>`: `</script>` внутри строки не закроет тег. */
function jsonForScript(value: string): string {
	return JSON.stringify(value).replace(/</g, '\\u003c');
}

/**
 * @param initialUrl проверенный `http(s)`-адрес превью
 * @param inspectSupported несёт ли страница по этому origin скрипт моста (иначе ⌖ выключена)
 * @param nonce одноразовый ключ для скрипта и стиля, под CSP документа
 */
export function buildPreviewChromeHtml(initialUrl: string, inspectSupported: boolean, nonce: string): string {
	const frameOrigin = new URL(initialUrl).origin;
	const initialJson = jsonForScript(initialUrl);
	const originJson = jsonForScript(frameOrigin);

	// CSP: the chrome runs from nonce'd inline script/style; the iframe may only load the
	// server origin (frame-src). connect-src stays 'none' — the iframe's own ws lives in its
	// own origin context, not the chrome document.
	const csp = [
		`default-src 'none'`,
		`frame-src ${frameOrigin}`,
		`img-src ${frameOrigin} https: data:`,
		`style-src 'nonce-${nonce}'`,
		`script-src 'nonce-${nonce}'`,
		'font-src data:',
	].join('; ');

	return `<!DOCTYPE html>
<html lang="ru">
<head>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<style nonce="${nonce}">
	html, body { height: 100%; margin: 0; padding: 0; background: var(--vscode-editor-background); color: var(--vscode-foreground); font-family: var(--vscode-font-family); }
	.vb-shell { display: flex; flex-direction: column; height: 100%; }
	.vb-bar { display: flex; align-items: center; gap: 4px; padding: 4px 6px; border-bottom: 1px solid var(--vscode-panel-border); }
	.vb-btn { cursor: pointer; border: none; background: transparent; color: var(--vscode-icon-foreground); border-radius: 4px; height: 24px; min-width: 24px; padding: 0 6px; font-size: 13px; }
	.vb-btn:hover:not(:disabled) { background: var(--vscode-toolbar-hoverBackground); }
	.vb-btn:disabled { opacity: 0.4; cursor: default; }
	.vb-btn.active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); color: var(--vscode-focusBorder); }
	.vb-addr { flex: 1; height: 24px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; padding: 0 8px; font-size: 12px; outline: none; }
	.vb-addr:focus { border-color: var(--vscode-focusBorder); }
	.vb-select { height: 24px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; font-size: 12px; }
	.vb-stage { flex: 1; overflow: auto; /* vibe-scroll: a webview document, its bar is styled by the webview host */ display: flex; justify-content: center; background: var(--vscode-editorWidget-background); }
	.vb-frame-wrap { width: 100%; height: 100%; box-shadow: none; }
	.vb-frame-wrap.sized { box-shadow: 0 0 0 1px var(--vscode-panel-border); margin: 8px auto; }
	iframe { width: 100%; height: 100%; border: none; background: #fff; display: block; }
</style>
</head>
<body>
<div class="vb-shell">
	<div class="vb-bar">
		<button class="vb-btn" id="vb-back" title="Назад" disabled>‹</button>
		<button class="vb-btn" id="vb-fwd" title="Вперёд" disabled>›</button>
		<button class="vb-btn" id="vb-reload" title="Обновить">⟳</button>
		<input class="vb-addr" id="vb-addr" spellcheck="false" />
		<select class="vb-select" id="vb-size" title="Размер вьюпорта">
			<option value="full">Полный</option>
			<option value="375x667">Телефон 375</option>
			<option value="768x1024">Планшет 768</option>
			<option value="1280x800">Десктоп 1280</option>
		</select>
		<button class="vb-btn" id="vb-rotate" title="Повернуть">⤧</button>
		<button class="vb-btn" id="vb-inspect" title="Выбрать элемент: клик по элементу превью отправит его селектор в чат (Alt+клик — родитель, Esc — отмена). Нужен мост VibeIDE в странице: статическое превью несёт его всегда, dev-сервер — через прокси." ${inspectSupported ? '' : 'disabled '}>⌖</button>
		<button class="vb-btn" id="vb-findings" title="Скрыть отметки проверки дизайна на странице (появляются после проверки; клик по отметке отправляет находку в чат)." hidden>⚑</button>
		<button class="vb-btn" id="vb-external" title="Открыть во внешнем браузере">↗</button>
	</div>
	<div class="vb-stage">
		<div class="vb-frame-wrap" id="vb-wrap">
			<iframe id="vb-frame" sandbox="${PREVIEW_FRAME_SANDBOX}" src="${escapeHtmlAttribute(initialUrl)}"></iframe>
		</div>
	</div>
</div>
<script nonce="${nonce}">
(function(){
	var vscode = acquireVsCodeApi();
	var ORIGIN = ${originJson};
	var frame = document.getElementById('vb-frame');
	var wrap = document.getElementById('vb-wrap');
	var addr = document.getElementById('vb-addr');
	var back = document.getElementById('vb-back');
	var fwd = document.getElementById('vb-fwd');
	var hist = [], idx = -1, current = '';
	var rotated = false, sizeVal = 'full';

	var findingsBtn = document.getElementById('vb-findings');
	findingsBtn.addEventListener('click', function(){
		if (frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerDesignOverlay: [] }, '*'); }
		findingsBtn.hidden = true;
	});

	var insp = document.getElementById('vb-inspect');
	var inspOn = false;
	function setInsp(v){
		inspOn = v && !insp.disabled;
		insp.classList.toggle('active', inspOn);
		if (frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerInspect: inspOn }, '*'); }
	}

	// Measuring the mobile layout: the frame is really narrowed, so media queries, flex wrapping and
	// the page's own resize handlers all run for that width. Faking a viewport number instead would
	// report the desktop layout under a mobile label — and a headless window forced to a minimum
	// width is exactly how a false "content is clipped on mobile" finding gets manufactured.
	var MOBILE_SCAN_WIDTH_PX = 390;
	// One frame to apply the width, one for the page's own layout/resize work, then measure.
	var SCAN_SETTLE_MS = 120;
	// Longer than the workbench-side scan timeout, so restoring is a backstop and not a race.
	var SCAN_RESTORE_MS = 8000;
	var savedWrapWidth = null;
	function restoreScanWidth(){
		if (savedWrapWidth === null){ return; }
		wrap.style.width = savedWrapWidth;
		savedWrapWidth = null;
		applySize();
	}
	function requestScan(viewport){
		if (viewport !== 'mobile'){
			frame.contentWindow.postMessage({ __vibeServerDesignScan: true, viewport: viewport || 'desktop' }, '*');
			return;
		}
		savedWrapWidth = wrap.style.width;
		wrap.className = 'vb-frame-wrap sized';
		wrap.style.width = MOBILE_SCAN_WIDTH_PX + 'px';
		requestAnimationFrame(function(){ setTimeout(function(){
			if (frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerDesignScan: true, viewport: 'mobile' }, '*'); }
			else { restoreScanWidth(); }
		}, SCAN_SETTLE_MS); });
		// A page that never answers must not leave the preview stuck at phone width.
		setTimeout(restoreScanWidth, SCAN_RESTORE_MS);
	}

	function buttons(){ back.disabled = idx <= 0; fwd.disabled = idx >= hist.length - 1; }
	function onNav(href, title){
		// Адрес приходит от страницы: в историю и в адресную строку попадает только адрес с origin этой вкладки.
		// Рамке по CSP другой origin не показать, так что чужой адрес — подмена адресной строки («страница выдаёт себя за другой сайт»)
		if (typeof href !== 'string' || (href !== ORIGIN && href.indexOf(ORIGIN + '/') !== 0)){ return; }
		if (href !== current){ hist = hist.slice(0, idx + 1); hist.push(href); idx = hist.length - 1; current = href; }
		addr.value = href; buttons();
		vscode.postMessage({ type: 'navigated', href: href, title: title });
		// A (re)loaded page starts with inspect off — re-arm it if the toggle is still on.
		if (inspOn && frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerInspect: true }, '*'); }
	}
	function goto(u){ frame.src = u; }
	function normalize(v){
		v = v.trim();
		if (/^https?:\\/\\//i.test(v)) { return v; }
		if (v.charAt(0) === '/') { return ORIGIN + v; }
		return ORIGIN + '/' + v;
	}
	function applySize(){
		if (sizeVal === 'full'){ wrap.className = 'vb-frame-wrap'; wrap.style.width = ''; wrap.style.height = ''; return; }
		var p = sizeVal.split('x'); var w = parseInt(p[0], 10), h = parseInt(p[1], 10);
		if (rotated){ var t = w; w = h; h = t; }
		wrap.className = 'vb-frame-wrap sized'; wrap.style.width = w + 'px'; wrap.style.height = h + 'px';
	}

	back.addEventListener('click', function(){ if (idx > 0){ idx--; current = hist[idx]; frame.src = current; addr.value = current; buttons(); } });
	fwd.addEventListener('click', function(){ if (idx < hist.length - 1){ idx++; current = hist[idx]; frame.src = current; addr.value = current; buttons(); } });
	document.getElementById('vb-reload').addEventListener('click', function(){ frame.src = current || frame.src; });
	document.getElementById('vb-external').addEventListener('click', function(){ vscode.postMessage({ type: 'open-external', href: current || frame.src }); });
	insp.addEventListener('click', function(){ setInsp(!inspOn); });
	document.getElementById('vb-size').addEventListener('change', function(e){ sizeVal = e.target.value; applySize(); });
	document.getElementById('vb-rotate').addEventListener('click', function(){ rotated = !rotated; applySize(); });
	addr.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ goto(normalize(addr.value)); } });

	// Страница в рамке — недоверенная сторона, поэтому у сообщения сверяется источник:
	//  - сообщения моста (поле __vibeBrowser) принимаются только от самой рамки, не от вложенных в неё окон;
	//  - команды хрома (поле type) принимаются только от хоста веб-вью, то есть от родительского окна, и никогда от рамки:
	//    иначе страница сама отправила бы себе navigate, design-overlay и остальное
	window.addEventListener('message', function(ev){
		var d = ev.data;
		if (!d || typeof d !== 'object') { return; }
		if (ev.source === frame.contentWindow){
			if (d.__vibeBrowser === 'nav'){ onNav(d.href, d.title); }
			else if (d.__vibeBrowser === 'console'){ vscode.postMessage({ type: 'console', level: d.level, text: d.text }); }
			else if (d.__vibeBrowser === 'external'){ vscode.postMessage({ type: 'open-external', href: d.href }); }
			else if (d.__vibeBrowser === 'scroll'){ vscode.postMessage({ type: 'scroll', x: d.x, y: d.y }); }
			else if (d.__vibeBrowser === 'inspect'){ setInsp(false); vscode.postMessage({ type: 'inspect', selector: d.selector, html: d.html, href: d.href, path: d.path }); }
			else if (d.__vibeBrowser === 'inspect-cancel'){ setInsp(false); }
			else if (d.__vibeBrowser === 'design-scan'){ restoreScanWidth(); vscode.postMessage({ type: 'design-scan', snapshot: d.snapshot, error: d.error }); }
			else if (d.__vibeBrowser === 'design-finding'){ vscode.postMessage({ type: 'design-finding', selector: d.selector, rule: d.rule }); }
			return;
		}
		if (ev.source !== window.parent) { return; }
		if (d.type === 'design-scan-request' && frame.contentWindow){ requestScan(d.viewport); }
		else if (d.type === 'design-overlay' && frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerDesignOverlay: d.items || [] }, '*'); findingsBtn.hidden = !(d.items && d.items.length); }
		else if (d.type === 'inspect-supported'){ insp.disabled = !d.value; if (!d.value){ setInsp(false); } }
		else if (d.type === 'navigate' && d.url){ goto(normalize(String(d.url))); }
		else if (d.type === 'reload'){ frame.src = current || frame.src; }
		else if (d.type === 'scroll-to' && frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerScrollTo: { x: d.x, y: d.y } }, '*'); }
	});

	addr.value = ${initialJson};
})();
</script>
</body>
</html>`;
}
