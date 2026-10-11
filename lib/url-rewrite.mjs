/**
 * 网页兼容模式（本地反向代理）的纯函数 URL 重写工具。
 *
 * 代理路径统一格式：/api/proxy/<scheme>/<host>/<rest><search>
 * 本模块只做字符串变换，不发网络请求；server.mjs 与单元测试直接复用。
 */

export const PROXY_API_PREFIX = "/api/proxy";

/* ─── 公网判定：拒绝回环 / 内网 / 链路本地 / 保留段，防本地服务被当作跳板 ─── */

function isPrivateIPv4(ip) {
  const o = ip.split(".").map(Number);
  if (o.length !== 4 || o.some(n => !Number.isInteger(n) || n < 0 || n > 255)) return true;
  const [a, b] = o;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;   /* 组播与保留段 */
  return false;
}

export function isPrivateHost(host) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  if (h.endsWith(".local") || h.endsWith(".internal") || h.endsWith(".home.arpa") || h.endsWith(".localdomain")) return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIPv4(h);
  if (h.includes(":")) {
    const v6 = h.replace(/^\[|\]$/g, "");
    if (v6 === "::1" || v6 === "::") return true;
    if (/^f[ce-f]/.test(v6) || /^fd/.test(v6)) return true;   /* fe80 链路本地 / fc-fd ULA */
    if (/^ff/.test(v6)) return true;        /* 组播 */
    return false;
  }
  return false;
}

/* 小鹅通已知域名：平台页面与其静态 / 接口资源（兼容模式默认可用） */
export function isXiaoeHost(host) {
  const h = String(host || "").toLowerCase();
  return h === "xiaoe-tech.com" || h.endsWith(".xiaoe-tech.com")
    || h === "xiaoeknow.com" || h.endsWith(".xiaoeknow.com");
}

/* ─── 代理路径解析 ─── */

const HOST_PORT_RE = /^([a-z0-9.-]+)(?::(\d{2,5}))?$/i;

/**
 * 把 /api/proxy/<scheme>/<host>/<rest> 解析回上游目标。
 * 返回 { scheme, host, port, rest }，不合法返回 null。
 * allowNonStandardPort 仅限测试环境开启（生产只代理 80/443）。
 */
export function parseProxyPath(pathname, { allowNonStandardPort = false } = {}) {
  if (!pathname || !pathname.startsWith(PROXY_API_PREFIX + "/")) return null;
  const rest = pathname.slice(PROXY_API_PREFIX.length + 1);
  const m = rest.match(/^(https?)\/([^/]+)(?:\/(.*))?$/i);
  if (!m) return null;
  const scheme = m[1].toLowerCase();
  const hm = m[2].toLowerCase().match(HOST_PORT_RE);
  if (!hm) return null;
  const port = hm[2] ? Number(hm[2]) : 0;
  if (port && port !== 80 && port !== 443 && !allowNonStandardPort) return null;
  return { scheme, host: hm[1], port, rest: m[3] || "" };
}

/** 上游完整 URL（search 由调用方拼接） */
export function upstreamUrl(parsed, search = "") {
  const portPart = parsed.port ? `:${parsed.port}` : "";
  return `${parsed.scheme}://${parsed.host}${portPart}/${parsed.rest}${search}`;
}

/* ─── 重写上下文 ─── */

const escRe = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * 生成可重写主机集合的正则源：页面自身主机、学习到的主机（含子域）与已知小鹅通域名。
 */
export function buildHostPattern(ctx) {
  const parts = [];
  const allowLoop = !!ctx?.allowLoopback;   /* 仅测试隔离环境放开内网主机 */
  const add = h => {
    h = String(h || "").toLowerCase().replace(/\.$/, "");
    if (h && !h.includes("/") && !h.includes(":") && (allowLoop || !isPrivateHost(h))) parts.push(`(?:[a-z0-9-]+\\.)*${escRe(h)}`);
  };
  add(ctx?.host);
  for (const h of ctx?.extraHosts || []) add(h);
  parts.push("(?:[a-z0-9-]+\\.)*xiaoe-tech\\.com", "(?:[a-z0-9-]+\\.)*xiaoeknow\\.com");
  return parts.join("|");
}

/** 判断某主机是否应经代理访问（与 buildHostPattern 同一套规则） */
export function hostInScope(host, ctx) {
  const h = String(host || "").toLowerCase().replace(/\.$/, "");
  if (!h) return false;
  if (!ctx?.allowLoopback && isPrivateHost(h)) return false;
  if (isXiaoeHost(h)) return true;
  const same = c => {
    c = String(c || "").toLowerCase();
    return h === c || h.endsWith("." + c);
  };
  if (same(ctx?.host)) return true;
  for (const c of ctx?.extraHosts || []) if (same(c)) return true;
  return false;
}

/** 绝对 URL → 代理路径；不在范围内返回 null */
export function toProxyUrl(rawUrl, ctx) {
  let u;
  try { u = new URL(String(rawUrl)); } catch { return null; }
  if (u.protocol !== "http:" && u.protocol !== "https:") return null;
  if (u.username || u.password) return null;
  if (u.port && u.port !== (u.protocol === "https:" ? "443" : "80") && !ctx?.allowNonStandardPort) return null;
  if (!hostInScope(u.hostname, ctx)) return null;
  const portPart = u.port && u.port !== "80" && u.port !== "443" ? `:${u.port}` : "";
  return `${PROXY_API_PREFIX}/${u.protocol.slice(0, -1)}/${u.hostname}${portPart}${u.pathname}${u.search}`;
}

/* ─── 文本级重写（JS / JSON 内的绝对 URL，含 \/ 转义形态） ─── */

/**
 * 重写文本中属于代理范围的绝对 http(s) URL。
 * 同时处理普通形态（https://host）与 JSON/JS 转义形态（https:\/\/host、https:\\/\\/host），
 * 替换为 /api/proxy/<scheme>/<host>（转义形态保持转义，保证 JSON 结构不破坏）。
 */
export function rewriteUrlLiterals(text, ctx) {
  const hostPat = buildHostPattern(ctx);
  if (!hostPat) return text;
  const re = new RegExp(
    "(https?):(\\\\{0,2})/(\\\\{0,2})/((?:" + hostPat + "))(?![a-z0-9.-])",
    "gi",
  );
  return text.replace(re, (m, scheme, bs1, _bs2, host) => {
    const slash = bs1 ? bs1 + "/" : "/";
    return `${slash}api${slash}proxy${slash}${scheme.toLowerCase()}${slash}${host.toLowerCase()}`;
  });
}

/* ─── HTML 重写 ─── */

const REWRITE_ATTRS = "href|src|action|poster|formaction|data-src|data-href|data-url|data-original|data-poster|data-background";

function rewriteAttrValue(v, ctx) {
  const t = String(v).trim();
  if (!t || t.startsWith("#") || t.startsWith("data:") || t.startsWith("blob:") || t.startsWith("javascript:")) return v;
  if (/^\/\//.test(t)) return rewriteAttrValue("https:" + t, ctx);
  if (/^https?:\/\//i.test(t)) return toProxyUrl(t, ctx) ?? v;
  /* 根相对路径：浏览器会解析到工作台源上，必须改写为代理路径；目录相对保持（天然落到代理目录） */
  if (ctx?.scheme && ctx?.host && t.startsWith("/") && !t.startsWith(PROXY_API_PREFIX + "/")) {
    const portPart = ctx.port && +ctx.port !== 80 && +ctx.port !== 443 ? `:${ctx.port}` : "";
    return toProxyUrl(`${ctx.scheme}://${ctx.host}${portPart}${t}`, ctx) ?? v;
  }
  return v;
}

function rewriteSrcset(v, ctx) {
  return String(v).split(",").map(part => {
    const trimmed = part.trim();
    if (!trimmed) return part;
    const sp = trimmed.search(/\s/);
    const url = sp === -1 ? trimmed : trimmed.slice(0, sp);
    const rest = sp === -1 ? "" : trimmed.slice(sp);
    return rewriteAttrValue(url, ctx) + rest;
  }).join(", ");
}

function rewriteCssText(css, ctx) {
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")]+)\1\s*\)/gi, (m, q, u) => {
      const r = rewriteAttrValue(u, ctx);
      return `url(${q}${r}${q})`;
    })
    .replace(/@import\s+(['"])([^'"]+)\1/gi, (m, q, u) => `@import ${q}${rewriteAttrValue(u, ctx)}${q}`);
}

/**
 * HTML 重写：去掉 CSP meta / base / integrity，重写属性与内联脚本、样式中的 URL，注入桥接脚本。
 * ctx: { scheme, host, extraHosts, bridge }
 */
export function rewriteHtml(html, ctx) {
  let out = String(html);
  out = out.replace(/<meta[^>]+http-equiv\s*=\s*["']?content-security-policy["']?[^>]*>/gi, "");
  out = out.replace(/<base\b[^>]*>/gi, "");
  out = out.replace(/\sintegrity\s*=\s*(["'])[^"']*\1/gi, "");

  /* 属性重写（srcset 单独处理） */
  out = out.replace(/\s(srcset|imagesrcset)\s*=\s*(["'])(.*?)\2/gi, (m, name, q, v) => ` ${name}=${q}${rewriteSrcset(v, ctx)}${q}`);
  out = out.replace(new RegExp(`\\s(${REWRITE_ATTRS})\\s*=\\s*(["'])(.*?)\\2`, "gi"), (m, name, q, v) => {
    const r = rewriteAttrValue(v, ctx);
    return ` ${name}=${q}${r}${q}`;
  });
  /* 行内 style 与 <style> 块 */
  out = out.replace(/\sstyle\s*=\s*(["'])(.*?)\1/gi, (m, q, v) => ` style=${q}${rewriteCssText(v, ctx)}${q}`);
  out = out.replace(/<style\b([^>]*)>([\s\S]*?)<\/style>/gi, (m, attrs, body) => `<style${attrs}>${rewriteCssText(body, ctx)}</style>`);
  /* 内联脚本（含 JSON 字符串里的转义 URL） */
  out = out.replace(/(<script\b[^>]*>)([\s\S]*?)(<\/script>)/gi, (m, open, body, close) =>
    /src\s*=/i.test(open) ? m : open + rewriteUrlLiterals(body, ctx) + close);

  /* 桥接脚本必须先于页面脚本执行 */
  if (ctx?.bridge) {
    if (/<head[^>]*>/i.test(out)) out = out.replace(/<head([^>]*)>/i, m => `${m}${ctx.bridge}`);
    else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html([^>]*)>/i, m => `${m}${ctx.bridge}`);
    else out = ctx.bridge + out;
  }
  return out;
}

/** 独立 CSS 文件 */
export function rewriteCss(css, ctx) { return rewriteCssText(css, ctx); }

/** 独立 JS / JSON 文本 */
export function rewriteJs(text, ctx) { return rewriteUrlLiterals(text, ctx); }
export function rewriteJson(text, ctx) { return rewriteUrlLiterals(text, ctx); }

/** HLS 播放列表：非注释行与 URI="..." 属性指向的地址重写为代理路径 */
export function rewriteM3u8(text, ctx, playlistUrl) {
  const resolve = u => {
    try { return toProxyUrl(new URL(u, playlistUrl).href, ctx) ?? u; } catch { return u; }
  };
  return String(text).split("\n").map(line => {
    const t = line.trim();
    if (!t) return line;
    if (t.startsWith("#")) return line.replace(/URI="(.*?)"/g, (m, u) => `URI="${resolve(u)}"`);
    return resolve(t);
  }).join("\n");
}

/** WebVTT 字幕：正文行可能是绝对 URL */
export function rewriteVtt(text, ctx, vttUrl) {
  return String(text).split("\n").map(line => {
    const t = line.trim();
    if (!t || t.startsWith("WEBVTT") || t.startsWith("NOTE") || t.startsWith("STYLE") || t.includes("-->") || t.startsWith("#")) return line;
    try { return toProxyUrl(new URL(t, vttUrl).href, ctx) ?? line; } catch { return line; }
  }).join("\n");
}

/** 3xx Location 头：范围内则改为代理路径，交给浏览器继续走兼容模式 */
export function rewriteLocation(loc, ctx) {
  const t = String(loc || "").trim();
  if (!t) return t;
  try {
    const abs = new URL(t, `${ctx?.scheme || "https"}://${ctx?.host || ""}/`).href;
    return toProxyUrl(abs, ctx) ?? t;
  } catch { return t; }
}
