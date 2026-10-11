/**
 * 极简 MCP（Model Context Protocol）客户端，供网课学习工作台本地服务调用。
 *
 * 支持两种传输：
 *   - stdio：在本机 spawn 一条命令，按 MCP 标准用「换行分隔的 JSON-RPC」通信
 *   - http：Streamable HTTP（POST JSON-RPC，响应可能是单个 JSON 或 SSE 流）
 *
 * 只实现工作台需要的方法：initialize / tools/list / tools/call。
 * 不依赖任何第三方包，Node 18+ 可直接运行。
 */
import { spawn } from "node:child_process";

const PROTOCOL_VERSION = "2024-11-05";
const CLIENT_INFO = { name: "study-desk", version: "1.4.0" };

export class McpError extends Error {
  constructor(data) {
    super(data?.message || JSON.stringify(data || {}));
    this.code = data?.code;
    this.data = data?.data;
  }
}

/* ─────────── stdio 传输 ─────────── */
export class McpStdioTransport {
  constructor({ command, args = [], env = {}, cwd }) {
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    this.stderrTail = "";
    this.closed = false;
  }
  start() {
    return new Promise((resolve, reject) => {
      let settled = false;
      this.proc = spawn(this.command, this.args, {
        env: { ...process.env, ...this.env },
        cwd: this.cwd,
        stdio: ["pipe", "pipe", "pipe"],
      });
      this.proc.on("error", err => { if (!settled) { settled = true; reject(err); } this.onClose?.(err); });
      this.proc.on("exit", (code, signal) => {
        if (!settled && code !== 0) { settled = true; reject(new Error(`进程退出（code=${code ?? "?"}${signal ? " signal=" + signal : ""}）`)); }
        settled = true;
        this.closed = true;
        this.onClose?.();
      });
      this.proc.stderr.on("data", d => { this.stderrTail = (this.stderrTail + d.toString("utf8")).slice(-4000); });
      let buf = "";
      this.proc.stdout.on("data", d => {
        buf += d.toString("utf8");
        let i;
        while ((i = buf.indexOf("\n")) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          if (!line) continue;
          let msg;
          try { msg = JSON.parse(line); } catch { continue; }   /* 忽略非 JSON 行 */
          try { this.onMessage?.(msg); } catch (e) { console.error("[mcp-client] onMessage 处理失败:", e); }
        }
      });
      this.proc.on("spawn", () => { if (!settled) { settled = true; resolve(); } });
    });
  }
  send(obj) {
    if (this.closed || !this.proc?.stdin?.writable) return Promise.reject(new Error("服务进程已退出" + (this.stderrTail ? "：" + this.stderrTail.split("\n").filter(Boolean).slice(-1)[0] : "")));
    return new Promise((resolve, reject) => {
      this.proc.stdin.write(JSON.stringify(obj) + "\n", err => err ? reject(err) : resolve());
    });
  }
  close() {
    this.closed = true;
    try { this.proc?.stdin?.end(); } catch {}
    try { this.proc?.kill(); } catch {}
  }
}

/* ─────────── Streamable HTTP 传输 ─────────── */
export class McpHttpTransport {
  constructor({ url, headers = {} }) {
    this.url = url;
    this.headers = headers;
    this.sessionId = null;
    this.closed = false;
  }
  async start() { /* HTTP 无需握手准备 */ }
  async send(obj) {
    if (this.closed) throw new Error("连接已关闭");
    const headers = {
      "Content-Type": "application/json",
      "Accept": "application/json, text/event-stream",
      ...this.headers,
    };
    if (this.sessionId) headers["MCP-Session-Id"] = this.sessionId;
    const resp = await fetch(this.url, { method: "POST", headers, body: JSON.stringify(obj) });
    const sid = resp.headers.get("mcp-session-id");
    if (sid) this.sessionId = sid;
    if (!resp.ok) {
      const text = await resp.text().catch(() => "");
      throw new Error(`HTTP ${resp.status}${text ? "：" + text.slice(0, 300) : ""}`);
    }
    if (resp.status === 202) return null;
    const ct = resp.headers.get("content-type") || "";
    if (ct.includes("text/event-stream")) return await this.#readSse(resp, obj?.id);
    const text = await resp.text();
    if (!text.trim()) return null;
    let msg;
    try { msg = JSON.parse(text); } catch { throw new Error("响应不是 JSON：" + text.slice(0, 200)); }
    this.onMessage?.(msg);
    return msg;
  }
  /* SSE：逐行读 data: 帧，直到等到与请求 id 匹配的响应 */
  async #readSse(resp, wantId) {
    return await new Promise((resolve, reject) => {
      const dec = new TextDecoder();
      let buf = "";
      let settled = false;
      const finish = (fn, val) => {
        if (settled) return;
        settled = true;
        try { resp.body?.cancel?.(); } catch {}
        fn(val);
      };
      (async () => {
        const reader = resp.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += dec.decode(value, { stream: true });
          let i;
          while ((i = buf.indexOf("\n")) >= 0) {
            const line = buf.slice(0, i).replace(/\r$/, "");
            buf = buf.slice(i + 1);
            if (!line.startsWith("data:")) continue;
            const payload = line.slice(5).trim();
            if (!payload || payload === "[DONE]") continue;
            let msg;
            try { msg = JSON.parse(payload); } catch { continue; }
            this.onMessage?.(msg);
            if (wantId == null || (msg?.id != null && msg.id === wantId)) finish(resolve, msg);
          }
        }
        finish(resolve, null);
      })().catch(err => finish(reject, err));
    });
  }
  async close() {
    this.closed = true;
    if (this.sessionId) {
      const sid = this.sessionId;
      this.sessionId = null;
      try {
        await fetch(this.url, {
          method: "DELETE",
          headers: { "MCP-Session-Id": sid, ...this.headers },
        });
      } catch { /* 会话清理失败不影响 */ }
    }
  }
}

/* ─────────── 客户端：请求配对 + 三个常用方法 ─────────── */
export class McpClient {
  constructor(transport) {
    this.transport = transport;
    this.nextId = 0;
    this.pending = new Map();
    this.serverInfo = null;
    transport.onMessage = msg => this.#onMessage(msg);
    transport.onClose = () => this.#drainPending(new Error("连接已断开"));
  }
  #onMessage(msg) {
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      clearTimeout(p.timer);
      if (msg.error) p.reject(new McpError(msg.error));
      else p.resolve(msg.result);
    }
    /* 服务器通知（logging 等）暂不处理 */
  }
  #drainPending(err) {
    for (const [, p] of this.pending) { clearTimeout(p.timer); p.reject(err); }
    this.pending.clear();
  }
  request(method, params, timeoutMs = 20000) {
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} 超时（${Math.round(timeoutMs / 1000)}s）`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.transport.send({ jsonrpc: "2.0", id, method, params }).catch(err => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(err);
      });
    });
  }
  notify(method, params) {
    return this.transport.send({ jsonrpc: "2.0", method, params }).catch(() => {});
  }
  async initialize() {
    const result = await this.request("initialize", {
      protocolVersion: PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    }, 30000);
    this.serverInfo = result?.serverInfo || null;
    this.notify("notifications/initialized");
    return result;
  }
  async listTools() {
    return await this.request("tools/list", {}, 30000);
  }
  async callTool(name, args, timeoutMs = 120000) {
    return await this.request("tools/call", { name, arguments: args || {} }, timeoutMs);
  }
  close() {
    this.#drainPending(new Error("连接已关闭"));
    this.transport.close?.();
  }
}

/* ─────────── 命令行拆分（支持引号，~ 展开由调用方处理） ─────────── */
export function splitCommandLine(line) {
  const out = [];
  let cur = "", quote = null, hasCur = false;
  for (const ch of String(line ?? "").trim()) {
    if (quote) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") { quote = ch; hasCur = true; }
    else if (/\s/.test(ch)) { if (hasCur) { out.push(cur); cur = ""; hasCur = false; } }
    else { cur += ch; hasCur = true; }
  }
  if (hasCur) out.push(cur);
  return out;
}
