/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Embedded Vibe Browser (roadmap VS.3): a webview editor that hosts the preview in an
 * `<iframe>` under our own chrome — address bar, back/forward/reload, responsive presets and
 * an "open externally" button. Page→chrome events (navigation, console, external links) arrive
 * from the injected client script via `postMessage`; the chrome relays them to this manager.
 */

import { Emitter, Event } from '../../../../../base/common/event.js';
import { Disposable, DisposableMap, DisposableStore } from '../../../../../base/common/lifecycle.js';
import { URI } from '../../../../../base/common/uri.js';
import { generateUuid } from '../../../../../base/common/uuid.js';
import { localize } from '../../../../../nls.js';
import { Registry } from '../../../../../platform/registry/common/platform.js';
import { IOpenerService } from '../../../../../platform/opener/common/opener.js';
import { WebviewInput } from '../../../webviewPanel/browser/webviewEditorInput.js';
import { IWebviewWorkbenchService } from '../../../webviewPanel/browser/webviewWorkbenchService.js';
import { ACTIVE_GROUP } from '../../../../services/editor/common/editorService.js';
import { Extensions as OutputExtensions, IOutputChannelRegistry, IOutputService } from '../../../../services/output/common/output.js';

const VIBE_BROWSER_VIEW_TYPE = 'vibeide.vibeBrowser';
const VIBE_SERVER_CONSOLE_CHANNEL_ID = 'vibeide.vibeServerConsole';

export class VibeBrowserManager extends Disposable {

	/** Open preview tabs (multi-preview). */
	private readonly _inputs = new Set<WebviewInput>();
	/** Most-recently opened/navigated tab — target for reuse and navigate(). */
	private _active: WebviewInput | undefined;
	private readonly _perInput = this._register(new DisposableMap<WebviewInput>());
	private _consoleChannelReady = false;
	/** When true, scroll in one preview is mirrored to the others. */
	private _scrollSync = false;
	/** Last URL the iframe reported (for the AI-loop context). */
	private _currentUrl: string | undefined;
	/** Ring buffer of recent console messages from the preview (newest last). */
	private readonly _console: Array<{ level: string; text: string }> = [];
	private readonly _onDidChangeProblems = this._register(new Emitter<void>());
	/** Fires when a new error/warning is captured (for the status-bar badge). */
	readonly onDidChangeProblems: Event<void> = this._onDidChangeProblems.event;

	constructor(
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IOutputService private readonly _outputService: IOutputService,
	) {
		super();
	}

	/** Enables/disables mirroring scroll across preview tabs. */
	setScrollSync(enabled: boolean): void {
		this._scrollSync = enabled;
	}

	/**
	 * Opens the embedded browser at `url`. By default re-points the active tab; with
	 * `newTab` opens an additional preview (multi-preview).
	 */
	open(url: string, newTab = false): void {
		const html = this._buildHtml(url);
		if (!newTab && this._active) {
			this._active.webview.setHtml(html);
			this._webviewWorkbenchService.revealWebview(this._active, ACTIVE_GROUP, false);
			return;
		}

		const input = this._webviewWorkbenchService.openWebview(
			{
				title: localize('vibeBrowser.title', "Vibe Server"),
				options: { retainContextWhenHidden: true, enableFindWidget: true },
				contentOptions: { allowScripts: true, allowForms: true },
				extension: undefined,
			},
			VIBE_BROWSER_VIEW_TYPE,
			localize('vibeBrowser.title', "Vibe Server"),
			undefined,
			{ group: ACTIVE_GROUP, preserveFocus: false },
		);
		this._inputs.add(input);
		this._active = input;

		const store = new DisposableStore();
		this._perInput.set(input, store);
		store.add(input.webview.onMessage(e => this._onMessage(e.message, input)));
		store.add(input.onWillDispose(() => {
			this._inputs.delete(input);
			this._perInput.deleteAndDispose(input);
			if (this._active === input) {
				this._active = this._inputs.values().next().value;
			}
		}));

		input.webview.setHtml(html);
	}

	/** Force-reloads every open preview tab. */
	reloadAll(): void {
		for (const input of this._inputs) {
			void input.webview.postMessage({ type: 'reload' });
		}
	}

	/** Navigates the active preview to `url` without rebuilding it. No-op when none open. */
	navigate(url: string): void {
		if (!this._active) {
			return;
		}
		void this._active.webview.postMessage({ type: 'navigate', url });
		this._webviewWorkbenchService.revealWebview(this._active, ACTIVE_GROUP, true);
	}

	private _onMessage(message: unknown, source: WebviewInput): void {
		if (!message || typeof message !== 'object') {
			return;
		}
		const m = message as { type?: string; href?: string; title?: string; level?: string; text?: string; x?: number; y?: number };
		switch (m.type) {
			case 'open-external':
				if (m.href) {
					void this._openerService.open(URI.parse(m.href), { openExternal: true });
				}
				break;
			case 'navigated':
				this._active = source;
				if (m.href) {
					this._currentUrl = m.href;
				}
				if (m.title) {
					source.setWebviewTitle(localize('vibeBrowser.titleWith', "Vibe Server — {0}", m.title));
				}
				break;
			case 'console': {
				const level = m.level ?? 'log';
				const text = m.text ?? '';
				this._console.push({ level, text });
				if (this._console.length > 100) {
					this._console.shift();
				}
				this._appendConsole(level, text);
				if (level === 'error' || level === 'warn') {
					this._onDidChangeProblems.fire();
				}
				break;
			}
			case 'scroll':
				if (this._scrollSync && typeof m.x === 'number' && typeof m.y === 'number') {
					for (const other of this._inputs) {
						if (other !== source) {
							void other.webview.postMessage({ type: 'scroll-to', x: m.x, y: m.y });
						}
					}
				}
				break;
		}
	}

	/** URL currently shown in the preview (for AI-loop context). */
	get currentUrl(): string | undefined {
		return this._currentUrl;
	}

	/** Recent console errors/warnings captured from the preview (for the AI-loop). */
	recentProblems(): ReadonlyArray<{ level: string; text: string }> {
		return this._console.filter(e => e.level === 'error' || e.level === 'warn');
	}

	/** Count of captured errors/warnings (for the status-bar badge). */
	problemCount(): number {
		return this.recentProblems().length;
	}

	private _appendConsole(level: string, text: string): void {
		if (!this._consoleChannelReady) {
			const registry = Registry.as<IOutputChannelRegistry>(OutputExtensions.OutputChannels);
			if (!registry.getChannel(VIBE_SERVER_CONSOLE_CHANNEL_ID)) {
				registry.registerChannel({
					id: VIBE_SERVER_CONSOLE_CHANNEL_ID,
					label: localize('vibeBrowser.consoleChannel', "Консоль Vibe Server"),
					log: false,
				});
			}
			this._consoleChannelReady = true;
		}
		this._outputService.getChannel(VIBE_SERVER_CONSOLE_CHANNEL_ID)?.append(`[${level}] ${text}\n`);
	}

	private _buildHtml(initialUrl: string): string {
		const uri = URI.parse(initialUrl);
		const frameOrigin = `${uri.scheme}://${uri.authority}`;
		const nonce = generateUuid();
		const initialJson = JSON.stringify(initialUrl);
		const originJson = JSON.stringify(frameOrigin);

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
	.vb-addr { flex: 1; height: 24px; border: 1px solid var(--vscode-input-border, transparent); background: var(--vscode-input-background); color: var(--vscode-input-foreground); border-radius: 4px; padding: 0 8px; font-size: 12px; outline: none; }
	.vb-addr:focus { border-color: var(--vscode-focusBorder); }
	.vb-select { height: 24px; background: var(--vscode-dropdown-background); color: var(--vscode-dropdown-foreground); border: 1px solid var(--vscode-dropdown-border, transparent); border-radius: 4px; font-size: 12px; }
	.vb-stage { flex: 1; overflow: auto; display: flex; justify-content: center; background: var(--vscode-editorWidget-background); }
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
		<button class="vb-btn" id="vb-external" title="Открыть во внешнем браузере">↗</button>
	</div>
	<div class="vb-stage">
		<div class="vb-frame-wrap" id="vb-wrap">
			<iframe id="vb-frame" src="${initialUrl}"></iframe>
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

	function buttons(){ back.disabled = idx <= 0; fwd.disabled = idx >= hist.length - 1; }
	function onNav(href, title){
		if (href !== current){ hist = hist.slice(0, idx + 1); hist.push(href); idx = hist.length - 1; current = href; }
		addr.value = href; buttons();
		vscode.postMessage({ type: 'navigated', href: href, title: title });
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
	document.getElementById('vb-size').addEventListener('change', function(e){ sizeVal = e.target.value; applySize(); });
	document.getElementById('vb-rotate').addEventListener('click', function(){ rotated = !rotated; applySize(); });
	addr.addEventListener('keydown', function(e){ if (e.key === 'Enter'){ goto(normalize(addr.value)); } });

	window.addEventListener('message', function(ev){
		var d = ev.data;
		if (!d) { return; }
		if (d.__vibeBrowser === 'nav'){ onNav(d.href, d.title); }
		else if (d.__vibeBrowser === 'console'){ vscode.postMessage({ type: 'console', level: d.level, text: d.text }); }
		else if (d.__vibeBrowser === 'external'){ vscode.postMessage({ type: 'open-external', href: d.href }); }
		else if (d.__vibeBrowser === 'scroll'){ vscode.postMessage({ type: 'scroll', x: d.x, y: d.y }); }
		else if (d.type === 'navigate' && d.url){ goto(d.url); }
		else if (d.type === 'reload'){ frame.src = current || frame.src; }
		else if (d.type === 'scroll-to' && frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerScrollTo: { x: d.x, y: d.y } }, '*'); }
	});

	addr.value = ${initialJson};
})();
</script>
</body>
</html>`;
	}
}
