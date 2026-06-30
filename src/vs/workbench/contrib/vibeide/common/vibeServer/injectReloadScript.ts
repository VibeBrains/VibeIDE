/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


/**
 * Pure HTML reload-script injection for Vibe Server. Kept side-effect free so it can be
 * unit-tested from `test/common/`. The server injects this ONLY into navigational
 * `text/html` responses — never into arbitrary HTML payloads (avoids the live-server
 * class of bug where injected markup corrupts HTML fetched as data).
 */

/** WebSocket path the injected client connects to for reload signals. */
export const VIBE_RELOAD_WS_PATH = '/__vibe_server_reload';

/** Marks an already-injected document so repeated injection is idempotent. */
const INJECTION_MARKER = 'data-vibe-server-reload';

/**
 * Builds the client-side script injected into served pages. Two roles:
 * (1) live reload — server→client `reload`/`css` over WebSocket, reconnecting on drop,
 *     honouring the `data-server-no-reload` opt-out, CSS hot-swap via cache-busting;
 * (2) browser bridge — posts navigation/console/external-link events to the parent window
 *     (the embedded Vibe Browser chrome) so the address bar, history and console mirror the
 *     page. Harmless when the page is opened in a real browser (parent === self, no listener).
 */
export function buildReloadClientScript(wsPath: string): string {
	// String-concatenated (not a template) to keep the payload literal and avoid any
	// accidental `</script>` sequence. wsPath is a fixed internal constant, not user input.
	return [
		'(function(){',
		'if(window.__vibeServerReload){return;}window.__vibeServerReload=true;',
		'var P=' + JSON.stringify(wsPath) + ';',
		'function post(m){try{parent.postMessage(m,"*");}catch(e){}}',
		'function report(){post({__vibeBrowser:"nav",href:location.href,title:document.title});}',
		'function refreshCss(){var ls=document.getElementsByTagName("link");for(var i=0;i<ls.length;i++){var l=ls[i];if(l.rel&&l.rel.toLowerCase()==="stylesheet"&&l.href){var h=l.href.replace(/[?&]_vibecss=\\d+/,"");l.href=h+(h.indexOf("?")>=0?"&":"?")+"_vibecss="+Date.now();}}}',
		'function connect(){',
		'var proto=location.protocol==="https:"?"wss:":"ws:";',
		'var ws=new WebSocket(proto+"//"+location.host+P);',
		'ws.onmessage=function(e){if(document.body&&document.body.hasAttribute("data-server-no-reload")){return;}if(e.data==="css"){refreshCss();}else{location.reload();}};',
		'ws.onclose=function(){setTimeout(connect,1000);};',
		'ws.onerror=function(){try{ws.close();}catch(x){}};',
		'}',
		'window.addEventListener("load",report);',
		'window.addEventListener("popstate",report);',
		'window.addEventListener("hashchange",report);',
		'var suppressScroll=false,scrollPending=false;',
		'window.addEventListener("scroll",function(){if(suppressScroll||scrollPending){return;}scrollPending=true;requestAnimationFrame(function(){scrollPending=false;post({__vibeBrowser:"scroll",x:window.scrollX,y:window.scrollY});});});',
		'window.addEventListener("message",function(ev){var d=ev.data;if(d&&d.__vibeServerScrollTo){suppressScroll=true;window.scrollTo(d.__vibeServerScrollTo.x,d.__vibeServerScrollTo.y);setTimeout(function(){suppressScroll=false;},80);}});',
		'["log","info","warn","error"].forEach(function(k){var o=console[k];console[k]=function(){post({__vibeBrowser:"console",level:k,text:Array.prototype.map.call(arguments,String).join(" ")});return o.apply(console,arguments);};});',
		'window.addEventListener("error",function(e){post({__vibeBrowser:"console",level:"error",text:(e.message||"error")+(e.filename?" ("+e.filename+":"+e.lineno+")":"")});});',
		'window.addEventListener("unhandledrejection",function(e){post({__vibeBrowser:"console",level:"error",text:"unhandled rejection: "+(e.reason&&e.reason.message||e.reason)});});',
		'if(window.fetch){var _f=window.fetch;window.fetch=function(){var a=arguments,u=(a[0]&&a[0].url)||a[0];return _f.apply(this,a).then(function(r){if(!r.ok){post({__vibeBrowser:"console",level:"error",text:"fetch "+r.status+" "+u});}return r;},function(err){post({__vibeBrowser:"console",level:"error",text:"fetch failed "+u+": "+err});throw err;});};}',
		'document.addEventListener("click",function(ev){var t=ev.target;var a=t&&t.closest?t.closest("a[href]"):null;if(!a||!a.href){return;}try{var u=new URL(a.href);if(u.origin!==location.origin){ev.preventDefault();post({__vibeBrowser:"external",href:a.href});}}catch(e){}},true);',
		'connect();',
		'report();',
		'})();',
	].join('');
}

/**
 * Injects the reload `<script>` into an HTML document. Insertion point, by priority:
 * before `</body>` → before `</head>` → before `</html>` → appended. Idempotent: a
 * document already carrying the marker is returned unchanged.
 */
export function injectReloadScript(html: string, wsPath: string = VIBE_RELOAD_WS_PATH): string {
	if (html.includes(INJECTION_MARKER)) {
		return html;
	}
	const tag = `<script ${INJECTION_MARKER}="1">${buildReloadClientScript(wsPath)}</script>`;
	for (const anchor of [/<\/body\s*>/i, /<\/head\s*>/i, /<\/html\s*>/i]) {
		const match = anchor.exec(html);
		if (match) {
			return html.slice(0, match.index) + tag + html.slice(match.index);
		}
	}
	return html + tag;
}
