/**
 * 兼容模式代理的服务端 Cookie 罐。
 *
 * 上游（如小鹅通）登录态保存在本机 ~/.study-desk/proxy-cookies.json（0600），
 * 不下发到浏览器 —— 这样 iframe 内不会因第三方 Cookie 限制反复要求扫码登录。
 */

import fs from "node:fs";
import path from "node:path";

export class CookieJar {
  constructor(file) {
    this.file = file;
    this.data = {};            /* domain → { name → { value, expires } } */
    this.saveTimer = null;
    try {
      const raw = JSON.parse(fs.readFileSync(file, "utf8"));
      if (raw && typeof raw === "object") this.data = raw;
    } catch {}
  }

  /* Set-Cookie 字符串数组入库；requestHost 用于缺省 Domain 归属与校验 */
  store(setCookies, requestHost) {
    if (!Array.isArray(setCookies) || !setCookies.length) return 0;
    const reqHost = String(requestHost || "").toLowerCase();
    let changed = 0;
    for (const raw of setCookies) {
      const first = String(raw).split(";", 1)[0];
      const eq = first.indexOf("=");
      if (eq <= 0) continue;
      const name = first.slice(0, eq).trim();
      const value = first.slice(eq + 1).trim();
      if (!name) continue;

      let domain = reqHost;
      let expires = 0;
      for (const attr of String(raw).split(";").slice(1)) {
        const [k, v = ""] = attr.trim().split("=");
        const key = k.trim().toLowerCase();
        if (key === "domain") {
          const d = v.trim().toLowerCase().replace(/^\./, "");
          /* 只接受当前请求主机的域或其父域，防止跨站投毒 */
          if (d && (reqHost === d || reqHost.endsWith("." + d))) domain = d;
        } else if (key === "expires") {
          const t = Date.parse(v.trim());
          if (!Number.isNaN(t)) expires = t;
        } else if (key === "max-age") {
          const n = Number(v.trim());
          if (Number.isFinite(n)) expires = n <= 0 ? 1 : Date.now() + n * 1000;
        }
      }
      this.data[domain] = this.data[domain] || {};
      this.data[domain][name] = { value, expires };
      changed++;
    }
    this.sweep();
    if (changed) this.persistSoon();
    return changed;
  }

  /* RFC6265 简化域匹配：host === domain 或 host 以 "." + domain 结尾 */
  header(host) {
    const h = String(host || "").toLowerCase();
    if (!h) return "";
    const pairs = [];
    const now = Date.now();
    for (const [domain, jar] of Object.entries(this.data)) {
      if (h !== domain && !h.endsWith("." + domain)) continue;
      for (const [name, c] of Object.entries(jar)) {
        if (c.expires && c.expires <= now) continue;
        pairs.push(`${name}=${c.value}`);
      }
    }
    return pairs.join("; ");
  }

  counts() {
    const out = {};
    for (const [domain, jar] of Object.entries(this.data)) out[domain] = Object.keys(jar).length;
    return out;
  }

  forget(host) {
    const h = String(host || "").toLowerCase();
    delete this.data[h];
    for (const domain of Object.keys(this.data)) if (domain.endsWith("." + h)) delete this.data[domain];
    this.persistSoon();
  }

  sweep() {
    const now = Date.now();
    for (const [domain, jar] of Object.entries(this.data)) {
      for (const [name, c] of Object.entries(jar)) if (c.expires && c.expires <= now) delete jar[name];
      if (!Object.keys(jar).length) delete this.data[domain];
    }
  }

  persistSoon() {
    clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => this.persist(), 400);
    this.saveTimer.unref?.();
  }

  persist() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = this.file + ".tmp";
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1));
      fs.renameSync(tmp, this.file);
      try { fs.chmodSync(this.file, 0o600); } catch {}
    } catch {}
  }
}
