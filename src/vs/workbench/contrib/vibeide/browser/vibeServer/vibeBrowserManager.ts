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

import { DocumentSnapshot, ViewportLabel } from '../../common/designReview/designSlopRules.js';

const VIBE_BROWSER_VIEW_TYPE = 'vibeide.vibeBrowser';
const VIBE_SERVER_CONSOLE_CHANNEL_ID = 'vibeide.vibeServerConsole';

/**
 * How a preview open lands on tabs: reuse the active one, keep one tab per service, or always
 * add another.
 */
export type VibeBrowserOpenMode = 'reuse' | 'perService' | 'newTab';

/**
 * Scheme+host+port of `url`, used as the per-service tab key. Falls back to the raw string for
 * anything unparseable so an odd URL still keys consistently instead of colliding on ''.
 */
function originOf(url: string): string {
	try {
		return new URL(url).origin;
	} catch {
		return url;
	}
}

/** One element pick from the preview inspect mode (page → chrome → manager). */
export interface IVibeBrowserElementPick {
	/** CSS selector computed in the page (id → tag.class:nth-of-type chain). */
	readonly selector: string;
	/** Truncated outerHTML of the picked element. */
	readonly html: string;
	/** Full page URL at pick time (may be a tunnelled origin on remote). */
	readonly href: string;
	/** `location.pathname` — the origin-independent half used for file mapping. */
	readonly path: string;
}

/**
 * Outcome of a design scan. `snapshot === undefined` means the page never answered — an
 * empty snapshot would read as "the page is clean", which is the opposite of the truth.
 */
export type DesignScanResult =
	| { readonly ok: true; readonly snapshot: DocumentSnapshot; readonly truncated: boolean }
	| { readonly ok: false; readonly reason: 'no-preview' | 'unsupported' | 'timeout' | 'page-error'; readonly detail?: string };

/** How long the page gets to answer before we call it a timeout. */
const DESIGN_SCAN_TIMEOUT_MS = 5000;

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

	private readonly _onDidPickElement = this._register(new Emitter<IVibeBrowserElementPick>());
	/** Fires when the user picks an element in inspect mode. */
	readonly onDidPickElement: Event<IVibeBrowserElementPick> = this._onDidPickElement.event;

	private readonly _onDidClickFinding = this._register(new Emitter<{ selector: string; rule: string }>());
	/** Fires when the user clicks a finding marker drawn by the overlay. */
	readonly onDidClickFinding: Event<{ selector: string; rule: string }> = this._onDidClickFinding.event;

	/**
	 * Origins whose pages carry the injected bridge script — the only ones where inspect and the
	 * design scan can work at all. The service owns the truth and pushes the whole set.
	 *
	 * Per ORIGIN, not one flag for the window: a multi-app workspace previews several apps side by
	 * side, and each gets its own proxy (or none). One shared flag both lied and got in the way —
	 * it left ⌖ enabled on a tab with no bridge, where the click silently did nothing, and any
	 * restart of the single server switched the button off on every other tab as well.
	 */
	private readonly _bridgedOrigins = new Set<string>();

	/** Which preview URL each tab currently shows — drives cookie-compat origin (un)registration. */
	private readonly _registeredUrlByInput = new Map<WebviewInput, string>();

	/**
	 * What each tab is: the shared preview (re-pointed by the `reuse` mode) or the tab belonging to
	 * one service, keyed by its origin (`http://localhost:5173`).
	 *
	 * The distinction is what keeps the two layouts from stepping on each other: `reuse` must never
	 * grab a service's own tab just because it happens to be active, and `perService` must find its
	 * service by origin — not by the current URL, which changes as you browse inside the preview.
	 * Tracked unconditionally, unlike `_registeredUrlByInput`, which only fills with cookie-compat on.
	 */
	private readonly _tabRoleByInput = new Map<WebviewInput, { readonly shared: boolean; readonly origin: string }>();

	/** Resolver for the design scan in flight, if any. One at a time — the scan is a snapshot, not a stream. */
	private _pendingDesignScan: { resolve: (snapshot: DesignScanResult) => void; timer: unknown } | undefined;

	constructor(
		private readonly _cookieCompat: { register(url: string): void; unregister(url: string): void } | undefined,
		@IWebviewWorkbenchService private readonly _webviewWorkbenchService: IWebviewWorkbenchService,
		@IOpenerService private readonly _openerService: IOpenerService,
		@IOutputService private readonly _outputService: IOutputService,
	) {
		super();
	}

	/**
	 * Keep the main-process cookie-compat registry in sync with what this tab shows.
	 * Refcounted per URL swap: unregister the previous URL, register the new one —
	 * same-origin navigations net out, the last tab closing drops the origin.
	 */
	private _trackPreviewUrl(input: WebviewInput, url: string): void {
		if (!this._cookieCompat) { return; }
		const prev = this._registeredUrlByInput.get(input);
		if (prev === url) { return; }
		if (prev !== undefined) { this._cookieCompat.unregister(prev); }
		this._cookieCompat.register(url);
		this._registeredUrlByInput.set(input, url);
	}

	private _untrackPreviewUrl(input: WebviewInput): void {
		const prev = this._registeredUrlByInput.get(input);
		if (prev !== undefined) {
			this._registeredUrlByInput.delete(input);
			this._cookieCompat?.unregister(prev);
		}
	}

	/** Enables/disables mirroring scroll across preview tabs. */
	setScrollSync(enabled: boolean): void {
		this._scrollSync = enabled;
	}

	/**
	 * Asks the previewed page for a snapshot of what it actually computed (sizes, colours,
	 * spacing) so the design rules can run against reality rather than against the source.
	 *
	 * Same precondition as inspect: the bridge script only lives in the static runtime, so a
	 * dev-server or Docker preview reports `unsupported` instead of quietly returning nothing.
	 */
	async scanDesign(viewport: ViewportLabel = 'desktop'): Promise<DesignScanResult> {
		if (!this._active) {
			return { ok: false, reason: 'no-preview' };
		}
		if (!this._inspectSupportedFor(this._active)) {
			return { ok: false, reason: 'unsupported' };
		}
		// A second request would orphan the first resolver; the newest caller wins the wait.
		this._settleDesignScan({ ok: false, reason: 'timeout', detail: 'заменён новым запросом' });

		const target = this._active;
		return new Promise<DesignScanResult>(resolve => {
			const timer = setTimeout(() => this._settleDesignScan({ ok: false, reason: 'timeout' }), DESIGN_SCAN_TIMEOUT_MS);
			this._pendingDesignScan = { resolve, timer };
			// The chrome narrows the frame for a mobile scan, so the page relayouts for real.
			void target.webview.postMessage({ type: 'design-scan-request', viewport });
		});
	}

	/**
	 * Draws (or clears, with an empty list) the findings overlay in every open preview.
	 *
	 * A list of selectors is a list of strings; the same findings framed on the page are places
	 * the reader can look at. Cheap enough to redraw wholesale — there is no diffing to get wrong.
	 */
	showFindings(items: readonly { selector: string; rule: string; severity: string }[]): void {
		for (const input of this._inputs) {
			void input.webview.postMessage({ type: 'design-overlay', items });
		}
	}

	private _settleDesignScan(result: DesignScanResult): void {
		const pending = this._pendingDesignScan;
		if (!pending) {
			return;
		}
		this._pendingDesignScan = undefined;
		clearTimeout(pending.timer as ReturnType<typeof setTimeout>);
		pending.resolve(result);
	}

	/**
	 * Declares which origins carry the bridge. Each open chrome is told about ITS own origin, so a
	 * tab previewing an app without a proxy shows ⌖ disabled while its neighbour stays usable.
	 */
	setBridgedOrigins(origins: readonly string[]): void {
		const next = new Set(origins);
		if (next.size === this._bridgedOrigins.size && [...next].every(o => this._bridgedOrigins.has(o))) {
			return;
		}
		this._bridgedOrigins.clear();
		for (const origin of next) { this._bridgedOrigins.add(origin); }
		for (const input of this._inputs) {
			void input.webview.postMessage({ type: 'inspect-supported', value: this._inspectSupportedFor(input) });
		}
	}

	/** Whether the tab's current origin carries the bridge. Unknown origin = no, never a guess. */
	private _inspectSupportedFor(input: WebviewInput): boolean {
		const origin = this._tabRoleByInput.get(input)?.origin;
		return origin !== undefined && this._bridgedOrigins.has(origin);
	}

	/**
	 * Opens the embedded browser at `url`.
	 *
	 * - `reuse` (default) re-points the shared preview tab — one preview for everything;
	 * - `perService` reveals the tab already opened for this service's origin, or makes one;
	 * - `newTab` always adds another preview.
	 *
	 * `title` names the tab after whatever it shows, so several previews stay distinguishable.
	 */
	open(url: string, mode: VibeBrowserOpenMode = 'reuse', title?: string): void {
		const origin = originOf(url);
		// The button state is baked per tab: this chrome shows THIS origin, and only that origin's
		// bridge decides whether ⌖ is usable here.
		const html = this._buildHtml(url, this._bridgedOrigins.has(origin));

		// The target is looked up by role, never "whatever is active": after working in the
		// per-service layout the active tab belongs to some service, and re-pointing it would
		// silently destroy that service's preview and leave two tabs claiming the same name.
		const existing = mode === 'reuse'
			? this._findTab(t => t.shared)
			: mode === 'perService'
				? this._findTab(t => !t.shared && t.origin === origin)
				: undefined;

		// The shared tab is labelled as such ("Превью: web"), never with the bare service name:
		// after switching layouts a service's own tab may still be open, and two tabs carrying the
		// identical name is exactly what makes the tab bar unreadable.
		const label = mode === 'reuse' && title
			? localize('vibeBrowser.sharedTitle', "Превью: {0}", title)
			: title;

		if (existing) {
			existing.webview.setHtml(html);
			this._trackPreviewUrl(existing, url);
			this._tabRoleByInput.set(existing, { shared: mode === 'reuse', origin });
			// Re-pointing keeps the tab but replaces what it shows, so its label has to follow —
			// otherwise the tab still claims the previously previewed service.
			existing.setWebviewTitle(label ?? localize('vibeBrowser.title', "Vibe Server"));
			this._active = existing;
			this._webviewWorkbenchService.revealWebview(existing, ACTIVE_GROUP, false);
			return;
		}

		// The tab is named after whatever it shows, in every mode: a shared tab that keeps saying
		// "Vibe Server" while showing a specific service is as misleading as a stale service name.
		const tabTitle = label ?? localize('vibeBrowser.title', "Vibe Server");
		const input = this._webviewWorkbenchService.openWebview(
			{
				title: tabTitle,
				options: { retainContextWhenHidden: true, enableFindWidget: true },
				contentOptions: { allowScripts: true, allowForms: true },
				extension: undefined,
			},
			VIBE_BROWSER_VIEW_TYPE,
			tabTitle,
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
			this._untrackPreviewUrl(input);
			this._tabRoleByInput.delete(input);
			if (this._active === input) {
				this._active = this._inputs.values().next().value;
			}
		}));

		input.webview.setHtml(html);
		this._trackPreviewUrl(input, url);
		// A `newTab` preview is an extra copy, not the shared tab: it must not become the target
		// that the single-tab layout re-points later.
		this._tabRoleByInput.set(input, { shared: mode === 'reuse', origin });
	}

	/** First open tab whose role matches, or undefined. */
	private _findTab(matches: (role: { shared: boolean; origin: string }) => boolean): WebviewInput | undefined {
		for (const input of this._inputs) {
			const role = this._tabRoleByInput.get(input);
			if (role && matches(role)) {
				return input;
			}
		}
		return undefined;
	}

	/**
	 * Прямоугольник активного превью в координатах окна — то, что нужно снимку экрана.
	 *
	 * Снять содержимое iframe изнутри нельзя: canvas-capture чужого origin в webview заблокирован
	 * (знание записано в previewInspectElement). Рабочий путь — нативный снимок окна с обрезкой по
	 * этому прямоугольнику, поэтому здесь отдаётся именно геометрия, а не картинка.
	 *
	 * `undefined` означает «превью не открыто или ещё не разложено» — снимать тогда нечего, и
	 * подменять это снимком всего окна нельзя: пользователь просил превью.
	 */
	getPreviewRect(): { x: number; y: number; width: number; height: number } | undefined {
		const container = this._active?.webview.container;
		if (!container) { return undefined; }
		const rect = container.getBoundingClientRect();
		if (rect.width < 1 || rect.height < 1) { return undefined; }
		return { x: Math.round(rect.x), y: Math.round(rect.y), width: Math.round(rect.width), height: Math.round(rect.height) };
	}

	/** Force-reloads every open preview tab. */
	reloadAll(): void {
		for (const input of this._inputs) {
			void input.webview.postMessage({ type: 'reload' });
		}
	}

	/**
	 * Navigates the active preview to `url`. No-op when none open.
	 *
	 * A same-origin move is a message to the page; a different origin needs the chrome document
	 * REBUILT, because its CSP names one `frame-src` and the iframe would be blocked without a word
	 * — the address bar accepted the url and the preview stayed blank. That is also how a tab moves
	 * between apps of a multi-app workspace.
	 */
	navigate(url: string): void {
		if (!this._active) {
			return;
		}
		const origin = originOf(url);
		const role = this._tabRoleByInput.get(this._active);
		if (role && role.origin !== origin) {
			this._tabRoleByInput.set(this._active, { shared: role.shared, origin });
			this._active.webview.setHtml(this._buildHtml(url, this._bridgedOrigins.has(origin)));
			this._trackPreviewUrl(this._active, url);
			this._webviewWorkbenchService.revealWebview(this._active, ACTIVE_GROUP, true);
			return;
		}
		void this._active.webview.postMessage({ type: 'navigate', url });
		this._trackPreviewUrl(this._active, url);
		this._webviewWorkbenchService.revealWebview(this._active, ACTIVE_GROUP, true);
	}

	private _onMessage(message: unknown, source: WebviewInput): void {
		if (!message || typeof message !== 'object') {
			return;
		}
		const m = message as { type?: string; href?: string; title?: string; level?: string; text?: string; x?: number; y?: number; selector?: string; html?: string; path?: string; snapshot?: DocumentSnapshot & { truncated?: boolean }; error?: string; rule?: string };
		switch (m.type) {
			case 'design-scan':
				if (m.error) {
					this._settleDesignScan({ ok: false, reason: 'page-error', detail: m.error });
				} else if (m.snapshot && Array.isArray(m.snapshot.elements)) {
					const { truncated, ...snapshot } = m.snapshot;
					this._settleDesignScan({ ok: true, snapshot, truncated: truncated === true });
				}
				break;
			case 'design-finding':
				if (typeof m.selector === 'string' && m.selector) {
					this._onDidClickFinding.fire({ selector: m.selector, rule: typeof m.rule === 'string' ? m.rule : '' });
				}
				break;
			case 'inspect':
				if (typeof m.selector === 'string' && m.selector.length > 0) {
					this._onDidPickElement.fire({
						selector: m.selector,
						html: typeof m.html === 'string' ? m.html : '',
						href: typeof m.href === 'string' ? m.href : '',
						path: typeof m.path === 'string' ? m.path : '',
					});
				}
				break;
			case 'open-external':
				if (m.href) {
					void this._openerService.open(URI.parse(m.href), { openExternal: true });
				}
				break;
			case 'navigated':
				this._active = source;
				if (m.href) {
					this._currentUrl = m.href;
					this._trackPreviewUrl(source, m.href);
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

	private _buildHtml(initialUrl: string, inspectSupported: boolean): string {
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
	.vb-btn.active { background: var(--vscode-toolbar-activeBackground, var(--vscode-toolbar-hoverBackground)); color: var(--vscode-focusBorder); }
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
		<button class="vb-btn" id="vb-inspect" title="Выбрать элемент: клик по элементу превью отправит его селектор в чат (Alt+клик — родитель, Esc — отмена). Нужен мост VibeIDE в странице: статическое превью несёт его всегда, dev-сервер — через прокси." ${inspectSupported ? '' : 'disabled '}>⌖</button>
		<button class="vb-btn" id="vb-findings" title="Скрыть отметки проверки дизайна на странице (появляются после проверки; клик по отметке отправляет находку в чат)." hidden>⚑</button>
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

	window.addEventListener('message', function(ev){
		var d = ev.data;
		if (!d) { return; }
		if (d.__vibeBrowser === 'nav'){ onNav(d.href, d.title); }
		else if (d.__vibeBrowser === 'console'){ vscode.postMessage({ type: 'console', level: d.level, text: d.text }); }
		else if (d.__vibeBrowser === 'external'){ vscode.postMessage({ type: 'open-external', href: d.href }); }
		else if (d.__vibeBrowser === 'scroll'){ vscode.postMessage({ type: 'scroll', x: d.x, y: d.y }); }
		else if (d.__vibeBrowser === 'inspect'){ setInsp(false); vscode.postMessage({ type: 'inspect', selector: d.selector, html: d.html, href: d.href, path: d.path }); }
		else if (d.__vibeBrowser === 'inspect-cancel'){ setInsp(false); }
		else if (d.__vibeBrowser === 'design-scan'){ restoreScanWidth(); vscode.postMessage({ type: 'design-scan', snapshot: d.snapshot, error: d.error }); }
		else if (d.type === 'design-scan-request' && frame.contentWindow){ requestScan(d.viewport); }
		else if (d.type === 'design-overlay' && frame.contentWindow){ frame.contentWindow.postMessage({ __vibeServerDesignOverlay: d.items || [] }, '*'); findingsBtn.hidden = !(d.items && d.items.length); }
		else if (d.__vibeBrowser === 'design-finding'){ vscode.postMessage({ type: 'design-finding', selector: d.selector, rule: d.rule }); }
		else if (d.type === 'inspect-supported'){ insp.disabled = !d.value; if (!d.value){ setInsp(false); } }
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
