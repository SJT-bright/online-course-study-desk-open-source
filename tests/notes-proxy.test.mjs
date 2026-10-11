/**
 * 笔记数据库（SQLite）+ 网页兼容模式（本地反代）测试：不依赖外部包。
 *
 * 单元：URL 重写 / Cookie 罐 / 桥接脚本。
 * 端到端：以隔离 STUDYDESK_HOME 与随机端口启动 server.mjs，
 *         并内嵌一个「假小鹅通」上游（登录重定向 + Cookie + CSP/XFO + 视频 + m3u8）。
 * 运行：node tests/notes-proxy.test.mjs
 */
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import vm from "node:vm";
import { mkdtempSync, rmSync } from "node:fs";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseProxyPath, upstreamUrl, toProxyUrl, isPrivateHost, hostInScope, rewriteUrlLiterals, rewriteHtml, rewriteM3u8, rewriteLocation } from "../lib/url-rewrite.mjs";
import { CookieJar } from "../lib/cookie-jar.mjs";
import { bridgeScript } from "../lib/proxy-bridge.mjs";

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
let passed = 0, failed = 0;
function ok(cond, label) {
  if (cond) { passed++; console.log("  ✓ " + label); }
  else { failed++; console.error("  ✗ " + label); }
}
const section = t => console.log(`\n── ${t} ──`);

/* ═══════════════ 单元：url-rewrite ═══════════════ */
section("单元 · parseProxyPath / 域名判定");
{
  const p = parseProxyPath("/api/proxy/https/app.xiaoe-tech.com/detail_p_id");
  ok(p?.scheme === "https" && p?.host === "app.xiaoe-tech.com" && p?.rest === "detail_p_id", "标准代理路径解析");
  ok(upstreamUrl(p, "?x=1") === "https://app.xiaoe-tech.com/detail_p_id?x=1", "上游 URL 还原");
  ok(parseProxyPath("/api/proxy/ftp/host/x") === null, "非 http(s) 拒绝");
  ok(parseProxyPath("/api/proxy/https/host:8443/x") === null, "非标准端口默认拒绝");
  ok(parseProxyPath("/api/proxy/https/host:8443/x", { allowNonStandardPort: true })?.port === 8443, "测试开关下允许非标准端口");
  ok(parseProxyPath("/api/other/x") === null, "非代理前缀拒绝");
  ok(isPrivateHost("localhost") && isPrivateHost("127.0.0.1") && isPrivateHost("10.1.2.3") && isPrivateHost("192.168.1.1")
     && isPrivateHost("172.16.0.1") && isPrivateHost("169.254.9.9") && isPrivateHost("::1") && isPrivateHost("fd00::1"), "内网 / 回环地址全部识别");
  ok(!isPrivateHost("app.xiaoe-tech.com") && !isPrivateHost("172.32.0.1") && !isPrivateHost("example.com"), "公网域名不误判");
}
section("单元 · toProxyUrl / hostInScope");
{
  const ctx = { scheme: "https", host: "shop.example.com", extraHosts: ["cdn.example.com"] };
  ok(toProxyUrl("https://shop.example.com/a?b=1", ctx) === "/api/proxy/https/shop.example.com/a?b=1", "同域绝对 URL → 代理路径");
  ok(toProxyUrl("https://sub.cdn.example.com/x", ctx) === "/api/proxy/https/sub.cdn.example.com/x", "extraHosts 子域覆盖");
  ok(toProxyUrl("https://app.xiaoe-tech.com/v/1.mp4", ctx)?.startsWith("/api/proxy/https/"), "小鹅通域名始终在范围内");
  ok(toProxyUrl("https://evil.com/x", ctx) === null, "范围外域名不重写");
  ok(toProxyUrl("http://127.0.0.1:8790/x", ctx) === null, "回环地址不重写");
  ok(hostInScope("a.shop.example.com", ctx) && !hostInScope("shop.example.com.evil.com", ctx), "域匹配不含后缀伪造");
}
section("单元 · rewriteUrlLiterals（含 JSON 转义形态）");
{
  const ctx = { scheme: "https", host: "app.xiaoe-tech.com" };
  ok(rewriteUrlLiterals('var u = "https://app.xiaoe-tech.com/api/info";', ctx)
     .includes('"/api/proxy/https/app.xiaoe-tech.com/api/info"'), "JS 普通形态重写");
  ok(rewriteUrlLiterals('{"play":"https:\\/\\/app.xiaoe-tech.com\\/v\\/a.mp4"}', ctx)
     .includes('{"play":"\\/api\\/proxy\\/https\\/app.xiaoe-tech.com\\/v\\/a.mp4"}'), "JSON 转义形态重写且保持转义");
  ok(rewriteUrlLiterals('"https://app.xiaoe-tech.com.evil.com/steal"', ctx) === '"https://app.xiaoe-tech.com.evil.com/steal"', "后缀伪造域不重写");
  ok(rewriteUrlLiterals('"https://cdn.app.xiaoe-tech.com/x.js"', ctx).includes("/api/proxy/https/cdn.app.xiaoe-tech.com/x.js"), "子域资源重写");
  ok(rewriteUrlLiterals('"https://other.com/keep"', ctx) === '"https://other.com/keep"', "范围外保持原样");
}
section("单元 · rewriteHtml");
{
  const ctx = { scheme: "https", host: "app.xiaoe-tech.com", bridge: "<script data-sd-bridge>/*B*/</script>" };
  const html = `<!DOCTYPE html><html><head>
    <meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">
    <base href="https://app.xiaoe-tech.com/">
    <link rel="stylesheet" href="/static/app.css">
    <script src="/static/app.js" integrity="sha384-AAA"></script>
    <script>fetch("/xe.course/info");var j={"p":"https:\\/\\/cdn.app.xiaoe-tech.com\\/v.mp4"};</script>
    </head><body><a href="https://app.xiaoe-tech.com/detail?id=1">详情</a>
    <img srcset="/a.png 1x, /b.png 2x" src="/a.png">
    <div style="background:url('/img/bg.png')"></div>
    正文纯文本 https://app.xiaoe-tech.com/visible 不应被改写</body></html>`;
  const out = rewriteHtml(html, ctx);
  ok(!/content-security-policy/i.test(out), "CSP meta 已移除");
  ok(!/<base\b/i.test(out), "base 标签已移除");
  ok(!/integrity=/i.test(out), "integrity 已移除");
  ok(out.indexOf("data-sd-bridge") < out.indexOf("fetch("), "桥接脚本先于页面内联脚本");
  ok(out.includes('href="/static/app.css"') === false && out.includes("/api/proxy/https/app.xiaoe-tech.com/static/app.css"), "根相对属性改写为代理路径");
  ok(out.includes("/api/proxy/https/app.xiaoe-tech.com/detail?id=1"), "绝对链接重写");
  ok(out.includes('"\\/api\\/proxy\\/https\\/cdn.app.xiaoe-tech.com\\/v.mp4"'), "内联脚本 URL 重写");
  ok(out.includes("/api/proxy/https/app.xiaoe-tech.com/a.png") && out.includes("/api/proxy/https/app.xiaoe-tech.com/b.png"), "srcset 重写");
  ok(out.includes("url('/api/proxy/https/app.xiaoe-tech.com/img/bg.png')"), "行内 style url() 重写");
  ok(out.includes("正文纯文本 https://app.xiaoe-tech.com/visible 不应被改写"), "可见文本不被改写");
}
section("单元 · m3u8 / Location / CookieJar / bridge");
{
  const ctx = { scheme: "https", host: "app.xiaoe-tech.com" };
  const m = rewriteM3u8('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="https://app.xiaoe-tech.com/key"\nhttps://cdn.app.xiaoe-tech.com/seg0.ts\nrel.ts', ctx, "https://app.xiaoe-tech.com/v/list.m3u8");
  ok(m.includes('URI="/api/proxy/https/app.xiaoe-tech.com/key"'), "m3u8 KEY URI 重写");
  ok(m.includes("/api/proxy/https/cdn.app.xiaoe-tech.com/seg0.ts"), "m3u8 分片重写");
  ok(m.includes("rel.ts"), "m3u8 相对分片保持");
  ok(rewriteLocation("/next?a=1", { scheme: "https", host: "app.xiaoe-tech.com" }) === "/api/proxy/https/app.xiaoe-tech.com/next?a=1", "相对 Location 重写");
  ok(rewriteLocation("https://evil.com/x", ctx) === "https://evil.com/x", "范围外 Location 保持");

  const jar = new CookieJar(path.join(tmpdir(), `sd-jar-test-${Date.now()}.json`));
  jar.store(["sid=abc123; Path=/; HttpOnly", "theme=dark; Domain=app.xiaoe-tech.com; Max-Age=3600"], "app.xiaoe-tech.com");
  ok(jar.header("app.xiaoe-tech.com").includes("sid=abc123"), "主机 Cookie 命中");
  ok(jar.header("app.xiaoe-tech.com").includes("theme=dark"), "Domain Cookie 命中");
  jar.store(["sid=abc123; Path=/; Domain=.xiaoe-tech.com"], "app.xiaoe-tech.com");
  ok(jar.header("cdn.app.xiaoe-tech.com").includes("sid=abc123"), "父域 Cookie 覆盖子域");
  ok(jar.header("other.com") === "", "跨域不发送");
  jar.store(["evil=1; Domain=other.com"], "app.xiaoe-tech.com");
  ok(!jar.data["other.com"], "跨站投毒 Cookie 被拒绝");
  jar.store(["gone=1; Max-Age=0"], "app.xiaoe-tech.com");
  ok(!jar.header("app.xiaoe-tech.com").includes("gone=1"), "过期 Cookie 不发送");
  ok(bridgeScript({ apiPrefix: "/api/proxy", prefix: "/api/proxy/https/app.xiaoe-tech.com", host: "app.xiaoe-tech.com", pageUrl: "https://app.xiaoe-tech.com/", extra: [] })
     .includes("__sd_cmd"), "桥接脚本包含指令协议");
  {
    const b = bridgeScript({ apiPrefix: "/api/proxy", prefix: "/api/proxy/https/app.xiaoe-tech.com", host: "app.xiaoe-tech.com", pageUrl: "https://app.xiaoe-tech.com/", extra: [] });
    ok(b.includes("duration === Infinity") && b.includes("live:"), "直播判定（duration=∞ → live 标志）");
    ok(b.includes('"getTime"') && b.includes('type: "time"'), "打点前精准回查协议（getTime/time）");
    ok(b.includes("isConnected") && b.includes("seeked"), "播放器换元素自愈 + seeked 即时回报");
    ok(b.includes("loginWall") && b.includes("login_redirect_times="), "登录墙检测（accounts/login/passport 域与 SSO 防循环参数）");
    ok(b.includes("patchCtor(\"Worker\"") && b.includes("patchCtor(\"EventSource\""), "Worker / EventSource 根相对路径映射进代理");
    const wall = bridgeScript({ apiPrefix: "/api/proxy", prefix: "/api/proxy/https/x.feishu.cn", host: "x.feishu.cn", pageUrl: "https://x.feishu.cn/drive/home?login_redirect_times=1", extra: [] });
    const code = wall.replace(/^<script[^>]*>/, "").replace(/<\/script>$/, "");
    let loginFlag = null;
    const FakeEl = class { setAttribute(){} };
    const FakeXHR = class { open(){} };
    const sandbox = {
      window: null, navigator: {}, XMLHttpRequest: FakeXHR, Element: FakeEl, Worker: class {},
      document: { readyState: "complete", querySelector: () => null, addEventListener(){}, title: "t" },
      addEventListener(){},
      HTMLScriptElement: null, HTMLImageElement: null, HTMLMediaElement: null, HTMLSourceElement: null,
      HTMLTrackElement: null, HTMLEmbedElement: null, HTMLObjectElement: null, HTMLAnchorElement: null, HTMLLinkElement: null,
      HTMLIFrameElement: null, parent: { postMessage(m){ loginFlag = m.login; } },
      location: { href: "https://x.feishu.cn/drive/home?login_redirect_times=1", origin: "https://x.feishu.cn" },
      URL, setInterval(){ return 0; }, setTimeout(fn){ fn(); }, MutationObserver: null,
    };
    sandbox.window = sandbox; sandbox.self = sandbox;
    new vm.Script(code, { filename: "bridge.js" }).runInContext(vm.createContext(sandbox));
    ok(loginFlag === true, "SSO 防循环中间页上报 login=true（前端给出切换直连出口）");
  }
}

/* ═══════════════ 端到端 ═══════════════ */
const freePort = () => new Promise(resolve => {
  const s = net.createServer();
  s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => resolve(p)); });
});

/* 假小鹅通上游：登录重定向 + Cookie 会话 + 带 CSP/XFO 的课程页 + 视频/字幕资源 */
function startUpstream() {
  return new Promise(resolve => {
    const up = http.createServer((req, res) => {
      const cookies = req.headers.cookie || "";
      if (req.url === "/login") {
        res.writeHead(302, { "Set-Cookie": "sid=test123; Path=/", Location: "/app" });
        return res.end();
      }
      if (req.url === "/whoami" || req.url.startsWith("/whoami?")) return res.end(JSON.stringify({ cookie: cookies, url: req.url }));
      if (req.url === "/app") {
        if (!cookies.includes("sid=test123")) { res.writeHead(401); return res.end("need login"); }
        const body = `<!DOCTYPE html><html><head>
<meta http-equiv="Content-Security-Policy" content="frame-ancestors 'none'">
<base href="http://127.0.0.1:${up.address().port}/">
<link rel="stylesheet" href="/static/app.css">
<script src="/static/app.js" integrity="sha384-AAA"></script>
<script>fetch("/xe.course/info");var j={"p":"https:\\/\\/127.0.0.1:${up.address().port}\\/v\\/real.mp4"};</script>
<title>测试课程页</title>
</head><body><a href="http://127.0.0.1:${up.address().port}/detail?id=1">详情</a>
<img srcset="/a.png 1x, /b.png 2x" src="/a.png">
<video src="/media/lesson.mp4"></video>
正文纯文本 http://127.0.0.1:${up.address().port}/visible 保持不变</body></html>`;
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "X-Frame-Options": "DENY", "Content-Security-Policy": "frame-ancestors 'none'", "Set-Cookie": "page=1; Path=/" });
        return res.end(body);
      }
      if (req.url === "/static/app.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        return res.end('xhr.open("POST", "http://127.0.0.1:' + up.address().port + '/xe.track");');
      }
      if (req.url === "/space/worker.js") {
        res.writeHead(200, { "Content-Type": "application/javascript" });
        return res.end("self.__fromUpstreamWorker = 1;");
      }
      if (req.url === "/accounts/page/login") {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        return res.end("<!DOCTYPE html><html><head><title>登录</title></head><body>login wall</body></html>");
      }
      if (req.url === "/media/lesson.mp4") {
        const full = Buffer.alloc(1000, 7);
        const range = req.headers.range || "";
        const m = range.match(/bytes=(\d+)-(\d*)/);
        if (m) {
          const start = Number(m[1]), end = m[2] ? Number(m[2]) : full.length - 1;
          res.writeHead(206, { "Content-Type": "video/mp4", "Content-Range": `bytes ${start}-${end}/${full.length}`, "Accept-Ranges": "bytes" });
          return res.end(full.subarray(start, end + 1));
        }
        res.writeHead(200, { "Content-Type": "video/mp4", "Content-Length": full.length, "Accept-Ranges": "bytes" });
        return res.end(full);
      }
      if (req.url === "/list.m3u8") {
        res.writeHead(200, { "Content-Type": "application/vnd.apple.mpegurl" });
        return res.end(`#EXTM3U\n#EXTINF:6,\nhttp://127.0.0.1:${up.address().port}/seg0.ts\n`);
      }
      res.writeHead(404); res.end("nf");
    });
    up.listen(0, "127.0.0.1", () => resolve(up));
  });
}

const home = mkdtempSync(path.join(tmpdir(), "sd-notes-e2e-"));
const PORT = await freePort();
const up = await startUpstream();
const UP_PORT = up.address().port;
console.log(`\n端到端：server=:${PORT} upstream=:${UP_PORT} home=${home}`);

const child = spawn(process.execPath, [path.join(ROOT, "server.mjs")], {
  cwd: ROOT,
  env: { ...process.env, STUDYDESK_PORT: String(PORT), STUDYDESK_HOME: home, STUDYDESK_PROXY_ALLOW_LOOPBACK: "1", STUDYDESK_PROXY_ANY_PORT: "1" },
  stdio: ["ignore", "pipe", "pipe"],
});
let serverLog = "";
child.stdout.on("data", d => serverLog += d);
child.stderr.on("data", d => serverLog += d);
const BASE = `http://127.0.0.1:${PORT}`;
/* 本机 API 能力令牌：从首页 HTML 提取一次，测试内的 /api/* 请求自动携带（模拟工作台自身页面） */
let __sdToken = "";
const _realFetch = globalThis.fetch;
globalThis.fetch = (url, opts = {}) => {
  try {
    const s = String(url);
    if (__sdToken && s.startsWith(BASE + "/api/") && !s.startsWith(BASE + "/api/proxy/")) {
      const u2 = new URL(s);
      u2.searchParams.set("sd_token", __sdToken);
      return _realFetch(u2, opts);
    }
  } catch {}
  return _realFetch(url, opts);
};
const initSdToken = async () => {
  const html = await _realFetch(BASE + "/").then(r => r.text());
  __sdToken = (html.match(/const __SD_TOKEN = "([0-9a-f]+)"/) || [])[1] || "";
  return !!__sdToken;
};
const waitReady = async () => {
  for (let i = 0; i < 100; i++) {
    try { const r = await _realFetch(`${BASE}/api/version`); if (r.status === 200 || r.status === 403) return true; } catch {}
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
};

try {
  ok(await waitReady(), "测试服务启动");
  ok(await initSdToken(), "本机 API 令牌已注入首页");
  const bare = await _realFetch(`${BASE}/api/version`);
  ok(bare.status === 403, "无令牌的本机 API 被拒绝（Referer 绕过失效）");

  /* ── 媒体 Range 语义 ── */
  section("端到端 · 媒体流 Range");
  {
    const mediaFile = path.join(home, "range-test.bin");
    fs.writeFileSync(mediaFile, Buffer.from("0123456789ABCDEFGHIJ", "utf8"));
    const murl = `${BASE}/api/media?path=${encodeURIComponent(mediaFile)}`;
    const suffix = await _realFetch(murl, { headers: { Range: "bytes=-5" } });
    const suffixBody = await suffix.text();
    ok(suffix.status === 206 && suffix.headers.get("content-range") === `bytes 15-19/20` && suffixBody === "FGHIJ",
       "后缀区间 bytes=-N 返回末尾 N 字节");
    const inv = await _realFetch(murl, { headers: { Range: "bytes=10-5" } });
    ok(inv.status === 416, "start>end 返回 416（不再产生负 Content-Length）");
    const tail = await _realFetch(murl, { headers: { Range: "bytes=18-" } });
    const tailBody = await tail.text();
    ok(tail.status === 206 && tailBody === "IJ", "开区间 bytes=N- 到文件尾");
  }

  /* ── 笔记数据库 ── */
  section("端到端 · 笔记数据库");
  {
    const st = await fetch(`${BASE}/api/notes/status`).then(r => r.json());
    ok(st.available === true && st.file.endsWith("notes.db"), "SQLite 笔记库可用（隔离 HOME）");

    const injKey = `link:https://app.example.com/x' OR 1=1 --`;
    let r = await (await fetch(`${BASE}/api/notes/save`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: injKey, html: "<p>小鹅通第一课 <b>重点</b>内容</p>", savedAt: 1000, name: "第一课", kind: "web", source: "https://app.example.com/x", tags: ["小鹅通"], status: "learning" }) })).json();
    ok(r.ok && r.changed && r.revision === 1, "首次保存入库 revision=1");
    r = await (await fetch(`${BASE}/api/notes/save`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: injKey, html: "<p>小鹅通第一课 <b>重点</b>内容（修订）</p>", savedAt: 2000, name: "第一课", kind: "web" }) })).json();
    ok(r.ok && r.revision === 2, "更新 revision=2");
    r = await (await fetch(`${BASE}/api/notes/save`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: injKey, html: "<p>过期乱序写入</p>", savedAt: 1500 }) })).json();
    ok(r.ok && r.changed === false, "乱序旧版本被拒绝");

    let list = await (await fetch(`${BASE}/api/notes/list?q=${encodeURIComponent("重点")}`)).json();
    ok(list.items.length === 1 && list.items[0].key === injKey, "中文关键词搜索命中（含注入形态 key）");
    list = await (await fetch(`${BASE}/api/notes/list?q=${encodeURIComponent("' OR 1=1 --")}`)).json();
    ok(list.items.length === 0, "SQL 注入串不产生泄漏结果");
    const detail = await (await fetch(`${BASE}/api/notes/detail?key=${encodeURIComponent(injKey)}`)).json();
    ok(detail.item?.html?.includes("修订") && detail.item?.text?.includes("修订"), "详情返回 html 与纯文本");
    const revs = await (await fetch(`${BASE}/api/notes/revisions?key=${encodeURIComponent(injKey)}`)).json();
    ok(revs.items.length === 2 && revs.items[0].savedAt === 2000, "历史版本 2 条且按时间倒序");
    const restored = await (await fetch(`${BASE}/api/notes/restore`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: injKey, id: revs.items[1].id }) })).json();
    ok(restored.ok && restored.html.includes("重点") && !restored.html.includes("修订"), "恢复到第一版");

    const imp = await (await fetch(`${BASE}/api/notes/import`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ notes: [
        { key: injKey, html: "<p>备份来的新版本</p>", savedAt: 3000, name: "第一课", kind: "web" },
        { key: injKey, html: "<p>备份来的旧版本</p>", savedAt: 500, name: "第一课", kind: "web" },
      ] }) })).json();
    ok(imp.ok && imp.updated === 1 && imp.skipped === 1, "导入按 savedAt 合并（新者胜，旧者跳过）");
    const afterImp = await (await fetch(`${BASE}/api/notes/detail?key=${encodeURIComponent(injKey)}`)).json();
    ok(afterImp.item.html.includes("备份来的新版本"), "导入后为最新版本");

    const exp = await (await fetch(`${BASE}/api/notes/export`)).json();
    ok(exp.app === "studydesk-notes" && exp.notes.length === 1, "导出完整笔记");

    const csrf = await fetch(`${BASE}/api/notes/save`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.com" },
      body: JSON.stringify({ key: "evil", html: "x", savedAt: 1 }) });
    ok(csrf.status === 403, "跨站 Origin 写入被拒");

    const del = await (await fetch(`${BASE}/api/notes/delete`, { method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ key: injKey }) })).json();
    ok(del.ok, "删除成功");
    const gone = await fetch(`${BASE}/api/notes/detail?key=${encodeURIComponent(injKey)}`);
    ok(gone.status === 404, "删除后详情 404");
  }

  /* ── 兼容模式代理 ── */
  section("端到端 · 网页兼容模式");
  {
    const st = await (await fetch(`${BASE}/api/proxy/status`)).json();
    ok(st.ok === true && Array.isArray(st.allowed), "代理状态可读");

    const iso = await fetch(`${BASE}/api/list?dir=/`, { headers: { Referer: `${BASE}/api/proxy/https/app.xiaoe-tech.com/x` } });
    ok(iso.status === 403, "被代理页面无法调用本机文件 API（隔离）");

    let r = await (await fetch(`${BASE}/api/proxy/allow`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host: `https://127.0.0.1:${UP_PORT}/` }) })).json();
    ok(r.ok && r.host === "127.0.0.1", "授权域名规范化入库");
    const csrf = await fetch(`${BASE}/api/proxy/allow`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.com" }, body: JSON.stringify({ host: "evil.com" }) });
    ok(csrf.status === 403, "跨站 Origin 授权被拒");

    let denied = await fetch(`${BASE}/api/proxy/https/example.com/`);
    ok(denied.status === 403, "未授权域名拒绝");
    denied = await fetch(`${BASE}/api/proxy/https/192.168.1.1/x`);
    ok(denied.status === 403, "内网域名拒绝");

    /* 根相对逃逸（SPA 动态 import / Worker / EventSource）：按 Referer 的上游主机透明代理 */
    const proxyPageRef = `${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/app`;
    const escaped = await fetch(`${BASE}/space/worker.js`, { headers: { Referer: proxyPageRef } });
    const escapedBody = await escaped.text();
    ok(escaped.status === 200 && escapedBody.includes("__fromUpstreamWorker"), "被代理页面的根相对请求透明代理到上游（Worker/import 类不再 403）");
    const escapedQuery = await fetch(`${BASE}/whoami?marker=1`, { headers: { Referer: proxyPageRef } });
    ok(escapedQuery.status === 200, "根相对逃逸携带查询串可访问");
    const rootKept = await fetch(`${BASE}/`, { headers: { Referer: proxyPageRef } });
    ok(rootKept.status === 403, "被代理页面请求工作台根路径仍被拒绝");
    const guideKept = await fetch(`${BASE}/转写配置指南.html`, { headers: { Referer: proxyPageRef } }).then(r2 => r2.status);
    ok(guideKept === 403, "被代理页面无法读取本机指南文件");

    const page = await fetch(`${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/login`, { redirect: "manual" });
    const body = await page.text();
    ok(page.status === 200, "登录 302 由代理跟随并到达课程页");
    ok(!page.headers.get("x-frame-options") && !page.headers.get("content-security-policy"), "XFO / CSP 响应头已剥离（可内嵌）");
    ok(!/http-equiv="Content-Security-Policy"/i.test(body) && !/<base\b/i.test(body) && !/integrity=/i.test(body), "CSP meta / base / integrity 已清除");
    ok(body.includes("data-sd-bridge") && body.indexOf("data-sd-bridge") < body.indexOf("fetch("), "桥接脚本已注入且先于页面脚本");
    ok(body.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/static/app.js`), "外链脚本重写为代理路径");
    ok(body.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/detail?id=1`), "站内绝对链接重写");
    ok(body.includes(`\\/api\\/proxy\\/https\\/127.0.0.1:${UP_PORT}\\/v\\/real.mp4`), "内联脚本 JSON 转义 URL 重写（保留原 https 方案与端口）");
    ok(body.includes(`正文纯文本 http://127.0.0.1:${UP_PORT}/visible 保持不变`), "可见文本不被改写");
    ok(body.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/a.png`) && body.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/b.png`), "srcset 重写");
    ok(body.includes(`<video src="/api/proxy/http/127.0.0.1:${UP_PORT}/media/lesson.mp4">`), "video src 重写（网页视频可打时间戳）");

    const who = await (await fetch(`${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/whoami`)).json();
    ok(who.cookie.includes("sid=test123") && who.cookie.includes("page=1"), "重定向链 Set-Cookie 进入服务端 Cookie 罐并回传上游");
    ok(!page.headers.getSetCookie || (page.headers.getSetCookie?.() || []).length === 0, "上游 Set-Cookie 不下发浏览器");

    const badBili = await fetch(`${BASE}/api/bili-live/media?u=${encodeURIComponent("abc")}&s=x`);
    ok(badBili.status === 400, "非法 bili-live 媒体地址返回 400（不再 500）");
    const evilBili = await fetch(`${BASE}/api/bili-live/media?u=${encodeURIComponent("https://evil-bilivideo.com/x.mp4")}&s=x`);
    ok(evilBili.status === 400, "子串伪造 bilivideo 域名被后缀锚定拦截");

    const js = await (await fetch(`${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/static/app.js`)).text();
    ok(js.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/xe.track`), "独立 JS 文件内 URL 重写");

    const range = await fetch(`${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/media/lesson.mp4`, { headers: { Range: "bytes=0-9" } });
    const buf = Buffer.from(await range.arrayBuffer());
    ok(range.status === 206 && buf.length === 10 && (range.headers.get("content-range") || "").includes("bytes 0-9/1000"), "视频 Range 拖动透传（206 + content-range）");

    const m3u8 = await (await fetch(`${BASE}/api/proxy/http/127.0.0.1:${UP_PORT}/list.m3u8`)).text();
    ok(m3u8.includes(`/api/proxy/http/127.0.0.1:${UP_PORT}/seg0.ts`), "HLS 播放列表分片重写");
  }
} catch (e) {
  failed++;
  console.error("  ✗ 测试执行异常：", e);
} finally {
  child.kill("SIGTERM");
  await new Promise(r => setTimeout(r, 300));
  try { rmSync(home, { recursive: true, force: true }); } catch {}
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
if (failed && serverLog) console.error("---- server log ----\n" + serverLog.slice(-3000));
process.exit(failed ? 1 : 0);
