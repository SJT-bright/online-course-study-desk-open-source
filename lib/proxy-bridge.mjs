/**
 * 兼容模式代理注入到页面的桥接脚本（内联、先于页面脚本执行）。
 *
 * 职责：
 *   1. 运行期 URL 重写：patch fetch / XHR / sendBeacon / 元素 src|href 属性，
 *      把页面发起的相对与绝对请求映射到 /api/proxy/... （覆盖 root-relative XHR 的 SPA 场景）。
 *   2. 媒体探测：把 <video>/<audio> 的播放时间 postMessage 给工作台父页，用于打时间戳；
 *      接收父页 seek 指令实现「点时间戳跳回网页视频对应位置」。
 */

/**
 * @param {object} cfg { apiPrefix, prefix, scheme, host, extra:[], pageUrl }
 * @returns {string} 完整 <script>…</script> 文本
 */
export function bridgeScript(cfg) {
  const json = JSON.stringify({
    apiPrefix: cfg.apiPrefix,
    prefix: cfg.prefix,
    host: cfg.host,
    pageUrl: cfg.pageUrl,
    extra: cfg.extra || [],
  });
  return `<script data-sd-bridge>(function(){
"use strict";
var SD = ${json};
var EXTRA = {}; (SD.extra || []).forEach(function(h){ EXTRA[h] = 1; });
var XO = /(^|\\.)xiaoe-tech\\.com$|(^|\\.)xiaoeknow\\.com$/;
function hostOk(h){
  h = String(h || "").toLowerCase();
  return h === SD.host || EXTRA[h] === 1 || XO.test(h);
}
function proxied(u){
  try { u = new URL(u, location.href); } catch (e) { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== (u.protocol === "https:" ? "443" : "80")) return null;
  if (u.origin === location.origin){
    if (u.pathname.indexOf(SD.apiPrefix + "/") === 0) return null;
    return SD.prefix + u.pathname + u.search + u.hash;
  }
  if (!hostOk(u.hostname)) return null;
  return SD.apiPrefix + "/" + u.protocol.slice(0, -1) + "/" + u.host + u.pathname + u.search + u.hash;
}
function rw(v){ if (typeof v !== "string" || !v) return v; var p = proxied(v); return p === null ? v : p; }

/* fetch / Request / XHR / sendBeacon */
var _fetch = window.fetch;
if (_fetch) window.fetch = function(input, init){
  try {
    if (typeof input === "string" || input instanceof URL) input = rw(String(input));
    else if (input && typeof input === "object" && typeof input.url === "string"){
      var nu = rw(input.url);
      if (nu !== input.url){
        if (typeof Request === "function") input = new Request(nu, input);
        else input = nu;
      }
    }
    if (init && typeof init.integrity !== "undefined" && init.integrity) init = Object.assign({}, init, { integrity: "" });
  } catch (e) {}
  return _fetch.call(this, input, init);
};
var _open = XMLHttpRequest.prototype.open;
XMLHttpRequest.prototype.open = function(m, u){
  var args = [].slice.call(arguments);
  try { args[1] = rw(u); } catch (e) {}
  return _open.apply(this, args);
};
var _beacon = navigator.sendBeacon && navigator.sendBeacon.bind(navigator);
if (_beacon) navigator.sendBeacon = function(u, d){ try { u = rw(u); } catch (e) {} return _beacon(u, d); };

/* 元素属性（动态创建的 script/img/video 等） */
var _setAttr = Element.prototype.setAttribute;
Element.prototype.setAttribute = function(n, v){
  try {
    n = String(n).toLowerCase();
    if ((n === "src" || n === "href" || n === "action" || n === "poster") && typeof v === "string") v = rw(v);
  } catch (e) {}
  return _setAttr.call(this, n, v);
};function patchProp(ctor, prop){
  try {
    if (!ctor || !ctor.prototype) return;
    var d = Object.getOwnPropertyDescriptor(ctor.prototype, prop);
    if (!d || !d.set || !d.get) return;
    Object.defineProperty(ctor.prototype, prop, {
      configurable: true, enumerable: d.enumerable,
      get: function(){ return d.get.call(this); },
      set: function(v){ try { if (typeof v === "string") v = rw(v); } catch (e) {} d.set.call(this, v); },
    });
  } catch (e) {}
}
if (window.HTMLScriptElement) patchProp(HTMLScriptElement, "src");
if (window.HTMLImageElement) patchProp(HTMLImageElement, "src");
if (window.HTMLMediaElement) patchProp(HTMLMediaElement, "src");
if (window.HTMLMediaElement) patchProp(HTMLMediaElement, "poster");
if (window.HTMLSourceElement) patchProp(HTMLSourceElement, "src");
if (window.HTMLTrackElement) patchProp(HTMLTrackElement, "src");
if (window.HTMLEmbedElement) patchProp(HTMLEmbedElement, "src");
if (window.HTMLObjectElement) patchProp(HTMLObjectElement, "data");
/* 链接跟随代理，保证站内跳转不跌出兼容模式 */
if (window.HTMLAnchorElement) patchProp(HTMLAnchorElement, "href");
if (window.HTMLLinkElement) patchProp(HTMLLinkElement, "href");
if (window.HTMLIFrameElement) patchProp(HTMLIFrameElement, "src");

/* Worker / EventSource 的根相对路径会落到工作台源上并被隔离拒绝，统一映射进代理 */
function patchCtor(name, wrap){
  try {
    var C = window[name];
    if (!C) return;
    var P = function(){ return wrap(C, arguments); };
    P.prototype = C.prototype;
    window[name] = P;
  } catch (e) {}
}
patchCtor("Worker", function(C, args){ args[0] = rw(args[0]); return new C(...args); });
patchCtor("SharedWorker", function(C, args){ args[0] = rw(args[0]); return new C(...args); });
patchCtor("EventSource", function(C, args){ args[0] = rw(args[0]); return new C(...args); });

/* ─── 媒体探测与跳转 ─── */
var cur = null;
function mediaInfo(){
  var live = !!(cur && (cur.duration === Infinity));
  return {
    t: (cur && cur.currentTime) || 0,
    dur: (live || !cur) ? (live ? Infinity : 0) : (cur.duration || 0),
    live: live,
    seekable: !!(cur && cur.seekable && cur.seekable.length > 0),
  };
}
/* 登录墙特征：平台把页面停在 accounts/login/passport 域或 SSO 防循环中间页。
   这类页面的后续跳转常依赖 top.location（沙箱 iframe 内被浏览器拦截），表现为白屏，
   上报后由工作台给出「切换直接打开」出口。 */
function loginWall(){
  try {
    if (/^(accounts|login|passport|sso)\./i.test(SD.host || "")) return true;
    if (/accounts\\/page\\/login|login_redirect_times=|\\/passport\\/|\\/login\\?/i.test(SD.pageUrl || "")) return true;
  } catch (e) {}
  return false;
}
function report(kind){
  try {
    var m = mediaInfo();
    parent.postMessage({
      __sd: 1, type: kind, t: m.t,
      dur: m.live ? 0 : m.dur, live: m.live,
      paused: !cur || !!cur.paused,
      title: document.title || "", src: SD.pageUrl,
      login: kind === "ready" ? loginWall() : false,
    }, "*");
  } catch (e) {}
}
function track(el){
  if (el.__sdTracked) return;
  el.__sdTracked = 1;
  var pick = function(){ cur = el; };
  ["play", "playing", "timeupdate", "loadedmetadata", "seeked", "pause", "ended"].forEach(function(ev){
    el.addEventListener(ev, function(){ pick(); report("media"); });
  });
}
setInterval(function(){
  try {
    if (cur && !cur.isConnected) cur = null;   /* 播放器换元素后自愈 */
    var list = document.querySelectorAll("video,audio");
    for (var i = 0; i < list.length; i++) track(list[i]);
  } catch (e) {}
}, 800);
window.addEventListener("message", function(ev){
  var d = ev.data;
  if (!d || d.__sd_cmd !== 1) return;
  if (d.type === "seek" && cur){
    try { cur.currentTime = parseFloat(d.t) || 0; if (d.play !== false && cur.play) cur.play(); } catch (e) {}
  } else if (d.type === "getTime"){
    /* 打点前的精准回查：以消息到达瞬间的 currentTime 为准，不经节流缓存 */
    var m = mediaInfo();
    try { parent.postMessage({ __sd: 1, type: "time", id: d.id, t: m.t, dur: m.live ? 0 : m.dur, live: m.live, paused: !cur || !!cur.paused, title: document.title || "" }, "*"); } catch (e) {}
  } else if (d.type === "ping"){
    report("ready");
  }
});
function announce(){ report("ready"); }
if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", announce);
else setTimeout(announce, 0);
try {
  var tEl = document.querySelector("title");
  if (tEl && window.MutationObserver) new MutationObserver(function(){ report("ready"); }).observe(tEl, { childList: true });
} catch (e) {}
})();</script>`;
}
