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
 * Builds the client-side script injected into served pages. Five roles:
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
 *     The page only measures; it never judges;
 * (5) findings overlay — on `__vibeServerDesignOverlay` the page frames the elements a review
 *     found and labels each with its rule id; a click on a label posts `design-finding` back.
 *     A finding you can point at on the page is not the same thing as a line in a list.
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
		// Состояния берутся из таблиц стилей, а не фокусировкой элемента: реальный focus() сдвинул
		// бы скролл и изменил ту самую страницу, которую мы измеряем. Селекторы разбираются один
		// раз на скан и кэшируются — обход правил на каждый элемент стоил бы слишком дорого.
		'var dsStateSel=null,dsStateBad=false;',
		'function dsStateRules(){if(dsStateSel){return dsStateSel;}var focus=[],hover=[];',
		'var sheets=document.styleSheets||[];',
		'for(var i=0;i<sheets.length;i++){var rules;',
		// Cross-origin таблица бросает SecurityError. Это «не посмотрели», а не «правила нет»:
		// флаг поднимается, и правила состояний на такой странице молчат.
		'try{rules=sheets[i].cssRules;}catch(e){dsStateBad=true;continue;}',
		'if(!rules){dsStateBad=true;continue;}',
		'for(var j=0;j<rules.length;j++){var sel=rules[j].selectorText;if(!sel){continue;}',
		'var parts=sel.split(",");',
		'for(var k=0;k<parts.length;k++){var p=parts[k].trim();',
		// Псевдокласс срезается, чтобы остаток можно было сопоставить с элементом через matches().
		'if(/:focus(-visible|-within)?\\b/.test(p)){focus.push(p.replace(/:focus(-visible|-within)?/g,""));}',
		'else if(/:hover\\b/.test(p)){hover.push(p.replace(/:hover/g,""));}}}}',
		'dsStateSel={focus:focus,hover:hover};return dsStateSel;}',
		'function dsMatchesAny(el,list){for(var i=0;i<list.length;i++){var s=(list[i]||"").trim();if(!s){continue;}',
		'try{if(el.matches(s)){return true;}}catch(e){}}return false;}',
		'function dsDisabled(el){return el.disabled===true||el.getAttribute("aria-disabled")==="true";}',
		// Доступное имя — то, что произнесёт программа чтения с экрана. Порядок стандартный;
		// собственный текст берётся ПОСЛЕ aria-атрибутов, потому что они его перекрывают.
		// Плейсхолдер сюда не входит намеренно: он исчезает при вводе и подписью не является.
		'function dsAccName(el){var v=(el.getAttribute("aria-label")||"").trim();if(v){return v.slice(0,120);}',
		'var lb=el.getAttribute("aria-labelledby");',
		'if(lb){var acc="";var ids=lb.split(/\\s+/);for(var i=0;i<ids.length;i++){var t=document.getElementById(ids[i]);if(t){acc+=" "+(t.textContent||"");}}',
		'acc=acc.trim();if(acc){return acc.slice(0,120);}}',
		'if(el.id){var lab=document.querySelector(\'label[for="\'+(window.CSS&&CSS.escape?CSS.escape(el.id):el.id)+\'"]\');',
		'if(lab&&(lab.textContent||"").trim()){return lab.textContent.trim().slice(0,120);}}',
		'if(el.closest){var wrap=el.closest("label");if(wrap&&(wrap.textContent||"").trim()){return wrap.textContent.trim().slice(0,120);}}',
		'var own=(el.textContent||"").trim();if(own){return own.slice(0,120);}',
		'var alt=el.getAttribute("alt");if(alt&&alt.trim()){return alt.trim().slice(0,120);}',
		'return (el.getAttribute("title")||"").trim().slice(0,120);}',
		'function dsFormField(el){var t=el.tagName.toLowerCase();return t==="input"||t==="select"||t==="textarea";}',
		// Текст пояснения, разрешённый по `aria-describedby`. Ссылка на несуществующий id даёт
		// пустую строку намеренно: на слух это ничем не отличается от отсутствия ссылки.
		'function dsDescribedBy(el){var db=el.getAttribute("aria-describedby");if(!db){return "";}',
		'var acc="";var ids=db.split(/\\s+/);for(var i=0;i<ids.length;i++){var t=document.getElementById(ids[i]);if(t){acc+=" "+(t.textContent||"");}}',
		'return acc.trim().slice(0,120);}',
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
		// Родство запоминается по ходу обхода: `querySelectorAll` идёт в документном порядке,
		// поэтому предок уже лежит в карте к моменту, когда доходит очередь до потомка. Без этой
		// связи правила восстанавливали её из селекторов и принимали предка за чужой слой.
		'var dsIds=new WeakMap();',
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
		// Ближайший предок, который сам попал в выборку: невидимые и служебные узлы пропускаются,
		// поэтому цепочка ведётся не до parentElement, а до первого известного.
		'var dsPid=-1;for(var pp=el.parentElement;pp;pp=pp.parentElement){if(dsIds.has(pp)){dsPid=dsIds.get(pp);break;}}',
		'dsIds.set(el,out.length);',
		'out.push({selector:inspSel(el),parentSelector:el.parentElement?inspSel(el.parentElement):"",parentId:dsPid,tag:tag,text:text,classes:(typeof el.className==="string"?el.className:"").trim().split(/\\s+/).filter(Boolean).slice(0,8),',
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
		'interactive:dsInteractive(el),',
		'outlineStyle:s.outlineStyle||"none",outlineWidthPx:dsNum(s.outlineWidth),',
		'hasFocusRule:dsMatchesAny(el,dsStateRules().focus),hasHoverRule:dsMatchesAny(el,dsStateRules().hover),',
		'disabled:dsDisabled(el),styleRulesUnreadable:dsStateBad,',
		'accessibleName:dsAccName(el),isFormField:dsFormField(el),inputType:String(el.getAttribute("type")||"").toLowerCase(),',
		'hasPlaceholder:!!(el.getAttribute("placeholder")||"").trim(),hasAltAttribute:el.hasAttribute("alt"),',
		'ariaInvalid:el.getAttribute("aria-invalid")==="true",describedByText:dsDescribedBy(el),',
		'isRequiredField:el.hasAttribute("required")||el.getAttribute("aria-required")==="true"});}',
		// SEO-часть снимка: то, чего не видно на скриншоте, но по чему страницу находят. Собирается
		// здесь же, потому что страница и так измеряется — второй проход стоил бы ещё одной
		// перезагрузки, а `<head>` от прогона к прогону не меняется.
		'var dsMeta=function(sel,attr){var n=document.querySelector(sel);return n?String(n.getAttribute(attr)||"").trim():"";};',
		'var dsLd=function(){var r={n:0,broken:0,types:[]};var ns=document.querySelectorAll(\'script[type="application/ld+json"]\');',
		'for(var i=0;i<ns.length;i++){r.n++;try{var p=JSON.parse(ns[i].textContent||"");var arr=Array.isArray(p)?p:[p];',
		'for(var j=0;j<arr.length;j++){var t=arr[j]&&arr[j]["@type"];if(t){r.types.push(String(t));}}}catch(e){r.broken++;}}return r;};',
		'var dsImgs=function(){var im=document.images||[];var no=0;for(var i=0;i<im.length;i++){if(!im[i].hasAttribute("alt")){no++;}}return {total:im.length,noAlt:no};};',
		'var dsL=dsLd();var dsI=dsImgs();',
		'post({__vibeBrowser:"design-scan",snapshot:{url:location.href,viewport:vp||undefined,viewportWidthPx:window.innerWidth,viewportHeightPx:window.innerHeight,',
		'documentScrollWidthPx:document.documentElement?document.documentElement.scrollWidth:0,elements:out,headings:heads,truncated:all.length>LIMIT,',
		'seo:{title:String(document.title||"").trim(),metaDescription:dsMeta(\'meta[name="description"]\',"content"),',
		'htmlLang:document.documentElement?String(document.documentElement.getAttribute("lang")||"").trim():"",',
		'canonical:dsMeta(\'link[rel="canonical"]\',"href"),robots:dsMeta(\'meta[name="robots"]\',"content").toLowerCase(),',
		'hasViewportMeta:!!document.querySelector(\'meta[name="viewport"]\'),',
		'ogTitle:dsMeta(\'meta[property="og:title"]\',"content"),ogDescription:dsMeta(\'meta[property="og:description"]\',"content"),',
		'ogImage:dsMeta(\'meta[property="og:image"]\',"content"),',
		'jsonLdCount:dsL.n,jsonLdBroken:dsL.broken,jsonLdTypes:dsL.types,imagesWithoutAlt:dsI.noAlt,imagesTotal:dsI.total}}});',
		'}',
		'window.addEventListener("message",function(ev){var d=ev.data;if(d&&d.__vibeServerDesignScan){try{dsScan(typeof d.viewport==="string"?d.viewport:undefined);}catch(e){post({__vibeBrowser:"design-scan",error:String(e&&e.message||e)});}}});',
		// Findings overlay: the chrome sends {__vibeServerDesignOverlay:[{selector,rule,severity}]}
		// and the page draws a frame plus a label on each element. A finding the reader can SEE on
		// the page is a different thing from a line in a list — the selector stops being a string
		// and becomes a place. Clicking a marker posts it back, so the chat can talk about that one.
		'var ovLayer=null,ovItems=[],ovTimer=0;',
		'function ovClear(){if(ovLayer&&ovLayer.parentNode){ovLayer.parentNode.removeChild(ovLayer);}ovLayer=null;}',
		'function ovColor(sev){return sev==="error"?"rgba(255,86,86,0.95)":sev==="warning"?"rgba(255,184,64,0.95)":"rgba(120,170,255,0.95)";}',
		'function ovDraw(items){',
		'ovClear();',
		'ovItems=items||[];',
		'if(!ovItems.length){return;}',
		'ovLayer=document.createElement("div");',
		'ovLayer.setAttribute("data-vibe-design-overlay","1");',
		'ovLayer.style.cssText="position:absolute;left:0;top:0;width:0;height:0;z-index:2147483646;";',
		'document.documentElement.appendChild(ovLayer);',
		'for(var i=0;i<ovItems.length&&i<60;i++){var it=ovItems[i];var el=null;',
		'try{el=document.querySelector(it.selector);}catch(e){el=null;}',
		'if(!el){continue;}',
		'var r=el.getBoundingClientRect();if(r.width<1&&r.height<1){continue;}',
		'var col=ovColor(it.severity);',
		'var box=document.createElement("div");',
		'box.style.cssText="position:absolute;pointer-events:none;border:2px solid "+col+";border-radius:2px;left:"+(r.left+window.scrollX)+"px;top:"+(r.top+window.scrollY)+"px;width:"+r.width+"px;height:"+r.height+"px;";',
		'var tag=document.createElement("div");',
		'tag.textContent=it.rule;',
		'tag.style.cssText="position:absolute;pointer-events:auto;cursor:pointer;left:"+(r.left+window.scrollX)+"px;top:"+Math.max(0,r.top+window.scrollY-18)+"px;background:"+col+";color:#111;font:600 11px/16px ui-monospace,Menlo,monospace;padding:1px 5px;border-radius:3px;white-space:nowrap;";',
		'tag.addEventListener("click",function(sel,rule){return function(ev){ev.preventDefault();ev.stopPropagation();post({__vibeBrowser:"design-finding",selector:sel,rule:rule});};}(it.selector,it.rule),true);',
		'ovLayer.appendChild(box);ovLayer.appendChild(tag);}',
		'}',
		'window.addEventListener("message",function(ev){var d=ev.data;if(d&&d.__vibeServerDesignOverlay!==undefined){try{ovDraw(d.__vibeServerDesignOverlay);}catch(e){ovClear();}}});',
		// A reflow moves the elements, so the markers have to be redrawn — not dropped. The design
		// scan itself resizes the frame (the mobile pass narrows it to 390px and restores it), and
		// clearing on resize raced that restore: the overlay was drawn and wiped a frame later.
		'window.addEventListener("resize",function(){if(!ovItems.length){return;}clearTimeout(ovTimer);ovTimer=setTimeout(function(){ovDraw(ovItems);},120);});',
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
