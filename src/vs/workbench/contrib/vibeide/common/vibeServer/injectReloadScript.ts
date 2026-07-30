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
 * Builds the client-side script injected into served pages. Four roles:
 * (1) live reload — server→client `reload`/`css` over WebSocket, reconnecting on drop,
 *     honouring the `data-server-no-reload` opt-out, CSS hot-swap via cache-busting;
 * (2) browser bridge — posts navigation/console/external-link events to the parent window
 *     (the embedded Vibe Browser chrome) so the address bar, history and console mirror the
 *     page. Harmless when the page is opened in a real browser (parent === self, no listener);
 * (3) element inspect — toggled by the chrome via `__vibeServerInspect` postMessage: hover
 *     highlights the element under the cursor, click computes a CSS selector and posts
 *     `__vibeBrowser:'inspect'` (Alt+click picks the parent, Escape cancels). Listeners sit
 *     on `window` in the capture phase so they beat the external-link handler on `document`;
 * (4) design scan — on `__vibeServerDesignScan` the page posts a snapshot of what it ACTUALLY
 *     computed (sizes, colours, borders, motion, geometry) for the rules in `common/designReview`.
 *     The page only measures; it never judges.
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
		// Element inspect: chrome toggles it with {__vibeServerInspect:boolean}; a pick is
		// one-shot (the chrome also flips its button off on the resulting 'inspect' message).
		'var inspOn=false,inspBox=null;',
		'function inspBoxEnsure(){if(!inspBox){inspBox=document.createElement("div");inspBox.style.cssText="position:fixed;z-index:2147483647;pointer-events:none;background:rgba(64,156,255,0.18);outline:2px solid rgba(64,156,255,0.9);border-radius:2px;display:none;left:0;top:0;width:0;height:0;";document.documentElement.appendChild(inspBox);}return inspBox;}',
		'function inspStop(){inspOn=false;if(inspBox){inspBox.style.display="none";}}',
		'function inspEsc(c){return window.CSS&&CSS.escape?CSS.escape(c):c;}',
		'function inspSel(el){var parts=[];var n=el;while(n&&n.nodeType===1&&n!==document.documentElement&&parts.length<8){if(n.id){parts.unshift("#"+inspEsc(n.id));break;}var s=n.tagName.toLowerCase();var cl=(typeof n.className==="string"?n.className:"").trim().split(/\\s+/).filter(function(c){return c;}).slice(0,2);if(cl.length){s+="."+cl.map(inspEsc).join(".");}var p=n.parentElement;if(p){var sib=[];for(var i=0;i<p.children.length;i++){if(p.children[i].tagName===n.tagName){sib.push(p.children[i]);}}if(sib.length>1){s+=":nth-of-type("+(sib.indexOf(n)+1)+")";}}parts.unshift(s);if(n===document.body){break;}n=p;}return parts.join(" > ");}',
		'window.addEventListener("message",function(ev){var d=ev.data;if(d&&typeof d.__vibeServerInspect==="boolean"){inspOn=d.__vibeServerInspect;if(!inspOn){inspStop();}}});',
		'window.addEventListener("mousemove",function(ev){if(!inspOn){return;}var t=ev.target;if(!t||t.nodeType!==1){return;}var r=t.getBoundingClientRect();var b=inspBoxEnsure();b.style.display="block";b.style.left=r.left+"px";b.style.top=r.top+"px";b.style.width=r.width+"px";b.style.height=r.height+"px";},true);',
		'window.addEventListener("keydown",function(ev){if(inspOn&&ev.key==="Escape"){inspStop();post({__vibeBrowser:"inspect-cancel"});}},true);',
		'window.addEventListener("click",function(ev){if(!inspOn){return;}ev.preventDefault();ev.stopPropagation();var t=ev.target;if(!t||t.nodeType!==1){return;}if(ev.altKey&&t.parentElement&&t.parentElement!==document.documentElement){t=t.parentElement;}var h=t.outerHTML||"";if(h.length>600){h=h.slice(0,600)+"\\u2026";}post({__vibeBrowser:"inspect",selector:inspSel(t),html:h,href:location.href,path:location.pathname});inspStop();},true);',
		// Design scan: the chrome asks with {__vibeServerDesignScan:true}; the page answers once
		// with a snapshot of what it ACTUALLY computed. Rules live in the workbench
		// (common/designReview) — the page only measures, it never judges.
		'function dsNum(v){var n=parseFloat(v);return isFinite(n)?n:0;}',
		'function dsMs(v){var s=String(v||"");var n=parseFloat(s);if(!isFinite(n)){return 0;}return /ms/.test(s)?n:n*1000;}',
		'function dsRgb(v){var m=/rgba?\\(([^)]+)\\)/.exec(v||"");if(!m){return null;}var p=m[1].split(",").map(function(x){return parseFloat(x);});return{c:[p[0]|0,p[1]|0,p[2]|0],a:p.length>3?p[3]:1};}',
		// Walk up through transparent ancestors: the effective background is what the reader sees.
		'function dsBg(el){var n=el;while(n&&n.nodeType===1){var v=dsRgb(getComputedStyle(n).backgroundColor);if(v&&v.a>0.05){return v.c;}n=n.parentElement;}return[255,255,255];}',
		'function dsCardDepth(el){var d=0,n=el.parentElement;while(n&&n.nodeType===1&&n!==document.body){var s=getComputedStyle(n);if((s.borderStyle&&s.borderStyle!=="none"&&dsNum(s.borderTopWidth)>0)||(s.boxShadow&&s.boxShadow!=="none")||dsNum(s.borderRadius)>=6){d++;}n=n.parentElement;}return d;}',
		'function dsOwnText(el){var t="";for(var i=0;i<el.childNodes.length;i++){var c=el.childNodes[i];if(c.nodeType===3){t+=c.nodeValue;}}return t.replace(/\\s+/g," ").trim().slice(0,300);}',
		'function dsInteractive(el){var tag=el.tagName.toLowerCase();if(tag==="button"||tag==="select"||tag==="textarea"||(tag==="a"&&el.hasAttribute("href"))||tag==="input"){return true;}var r=el.getAttribute("role");return r==="button"||r==="link"||typeof el.onclick==="function";}',
		// Largest of the four corners: `borderRadius` is empty when the corners differ.
		'function dsRadius(s){return Math.max(dsNum(s.borderTopLeftRadius),dsNum(s.borderTopRightRadius),dsNum(s.borderBottomRightRadius),dsNum(s.borderBottomLeftRadius));}',
		// Colour of the THICKEST side: a one-sided accent border is the tell, and its colour is what matters.
		'function dsBorderColor(s,w){var side="Top";var m=w.top;if(w.right>m){m=w.right;side="Right";}if(w.bottom>m){m=w.bottom;side="Bottom";}if(w.left>m){m=w.left;side="Left";}return dsRgb(s["border"+side+"Color"]);}',
		// Shape primitives of a direct inline SVG child — placeholder hero art is assembled from them.
		'function dsSvgShapes(el){var c=el.firstElementChild;if(!c||c.tagName.toLowerCase()!=="svg"){return 0;}try{return c.querySelectorAll("path,circle,rect,polygon,ellipse,line").length;}catch(e){return 0;}}',
		// How the text really broke into lines: a Range per word, grouped by baseline. The source
		// cannot answer this — the font, the box and the browser's hyphenation decide it. Budgeted
		// (a sample of elements, a cap on words) because every word costs a layout rect.
		'var dsLineBudget=40;',
		'function dsLines(el){',
		'if(dsLineBudget<=0){return null;}',
		'var node=null;for(var i=0;i<el.childNodes.length;i++){var c=el.childNodes[i];if(c.nodeType===1){return null;}if(c.nodeType===3&&c.nodeValue&&c.nodeValue.trim()){if(node){return null;}node=c;}}',
		'if(!node){return null;}',
		'var text=node.nodeValue;if(text.length<20||text.length>400){return null;}',
		'dsLineBudget--;',
		'var range=document.createRange();var lines=[];var cur=null;var re=/\\S+/g;var m,seen=0;',
		'while((m=re.exec(text))&&seen<120){seen++;',
		'try{range.setStart(node,m.index);range.setEnd(node,m.index+m[0].length);}catch(e){break;}',
		'var rect=range.getBoundingClientRect();if(!rect||!rect.height){continue;}',
		'var top=Math.round(rect.top);',
		'if(!cur||Math.abs(cur.top-top)>2){cur={top:top,last:m[0],words:0};lines.push(cur);}',
		'cur.last=m[0];cur.words++;}',
		'if(lines.length<2){return{count:lines.length,hanging:0,lastWords:lines.length?lines[0].words:0};}',
		// A one- or two-letter word left at a line end is a hanging preposition or conjunction:
		// Russian typography ties it to the word that follows with a non-breaking space.
		'var hang=0;for(var j=0;j<lines.length-1;j++){var w=String(lines[j].last||"").replace(/[^\\wА-Яа-яЁё]/g,"");if(w.length>0&&w.length<=2){hang++;}}',
		'return{count:lines.length,hanging:hang,lastWords:lines[lines.length-1].words};',
		'}',
		'function dsScan(vp){',
		'var out=[],heads=[],all=document.body?document.body.querySelectorAll("*"):[];',
		// Cap the payload: a snapshot is a sample of the page, not a copy of it.
		'var LIMIT=400;',
		'for(var i=0;i<all.length&&out.length<LIMIT;i++){var el=all[i];',
		'var r=el.getBoundingClientRect();if(r.width<1||r.height<1){continue;}',
		'var s=getComputedStyle(el);if(s.display==="none"||s.visibility==="hidden"||dsNum(s.opacity)===0){continue;}',
		'var tag=el.tagName.toLowerCase();if(tag==="script"||tag==="style"||tag==="svg"||tag==="path"){continue;}',
		'var text=dsOwnText(el);var col=dsRgb(s.color);var own=dsRgb(s.backgroundColor);',
		'var bw={top:dsNum(s.borderTopWidth),right:dsNum(s.borderRightWidth),bottom:dsNum(s.borderBottomWidth),left:dsNum(s.borderLeftWidth)};',
		'var bc=dsBorderColor(s,bw);var kids=[];for(var k=0;k<el.children.length&&k<6;k++){kids.push(el.children[k].tagName.toLowerCase());}',
		'var lh=s.lineHeight==="normal"?dsNum(s.fontSize)*1.2:dsNum(s.lineHeight);var lines=(text&&lh>0&&r.height>lh*1.4)?dsLines(el):null;',
		'if(/^h[1-4]$/.test(tag)&&text){heads.push({tag:tag,text:text.slice(0,80),fontSizePx:dsNum(s.fontSize)});}',
		'out.push({selector:inspSel(el),parentSelector:el.parentElement?inspSel(el.parentElement):"",tag:tag,text:text,classes:(typeof el.className==="string"?el.className:"").trim().split(/\\s+/).filter(Boolean).slice(0,8),',
		'childTags:kids,cardDepth:dsCardDepth(el),fontSizePx:dsNum(s.fontSize),lineHeightPx:lh,',
		'letterSpacingPx:s.letterSpacing==="normal"?0:dsNum(s.letterSpacing),fontFamily:s.fontFamily||"",fontWeight:dsNum(s.fontWeight)||400,',
		'fontStyle:s.fontStyle||"normal",textTransform:s.textTransform||"none",textAlign:s.textAlign||"start",color:col?col.c:[0,0,0],backgroundColor:dsBg(el),',
		'ownBackgroundAlpha:own?own.a:0,backgroundImage:(s.backgroundImage||"none").slice(0,200),backgroundClip:s.webkitBackgroundClip||s.backgroundClip||"border-box",',
		'boxShadow:(s.boxShadow||"none").slice(0,200),backdropFilter:((s.backdropFilter||s.webkitBackdropFilter)||"none").slice(0,80),',
		'borderRadiusPx:dsRadius(s),borderWidthPx:bw,borderColor:bc?bc.c:[0,0,0],borderAlpha:bc?bc.a:0,',
		'animationName:s.animationName||"none",animationTimingFunction:(s.animationTimingFunction||"ease").slice(0,80),animationDurationMs:dsMs(s.animationDuration),',
		'transitionProperty:(s.transitionProperty||"none").slice(0,120),transitionTimingFunction:(s.transitionTimingFunction||"ease").slice(0,80),',
		'position:s.position||"static",zIndex:s.zIndex==="auto"?0:(parseInt(s.zIndex,10)||0),overflowX:s.overflowX||"visible",overflowY:s.overflowY||"visible",',
		'widthPx:r.width,heightPx:r.height,leftPx:r.left+window.scrollX,topPx:r.top+window.scrollY,',
		'scrollWidthPx:el.scrollWidth||0,clientWidthPx:el.clientWidth||0,',
		'paddingPx:{top:dsNum(s.paddingTop),right:dsNum(s.paddingRight),bottom:dsNum(s.paddingBottom),left:dsNum(s.paddingLeft)},',
		'marginPx:{top:dsNum(s.marginTop),right:dsNum(s.marginRight),bottom:dsNum(s.marginBottom),left:dsNum(s.marginLeft)},',
		'imgSrc:tag==="img"?String(el.currentSrc||el.getAttribute("src")||"").slice(0,200):"",imgNaturalWidthPx:tag==="img"?(el.naturalWidth||0):0,',
		'svgShapeCount:dsSvgShapes(el),textLineCount:lines?lines.count:0,linesEndingWithShortWord:lines?lines.hanging:0,lastLineWordCount:lines?lines.lastWords:0,',
		'interactive:dsInteractive(el)});}',
		'post({__vibeBrowser:"design-scan",snapshot:{url:location.href,viewport:vp||undefined,viewportWidthPx:window.innerWidth,viewportHeightPx:window.innerHeight,',
		'documentScrollWidthPx:document.documentElement?document.documentElement.scrollWidth:0,elements:out,headings:heads,truncated:all.length>LIMIT}});',
		'}',
		'window.addEventListener("message",function(ev){var d=ev.data;if(d&&d.__vibeServerDesignScan){try{dsScan(typeof d.viewport==="string"?d.viewport:undefined);}catch(e){post({__vibeBrowser:"design-scan",error:String(e&&e.message||e)});}}});',
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
