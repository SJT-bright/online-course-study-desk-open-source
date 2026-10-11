/**
 * 极简 WebSocket 客户端（零依赖，基于 node:tls/net）
 * 专为火山引擎 ASR 这类「握手头鉴权 + 二进制帧」服务设计：
 *  - 握手失败时能拿到精确 HTTP 状态码与错误体（401/403/429…），便于归类错误
 *  - 支持分片消息重组、自动回 PONG、关闭帧
 */
import net from "node:net";
import tls from "node:tls";
import crypto from "node:crypto";

const GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export class RawWebSocket {
  constructor() {
    this.onopen = null;
    this.onmessage = null;   /* (Buffer) => void */
    this.onerror = null;     /* ({ status, body, message }) => void */
    this.onclose = null;     /* () => void */
    this.readyState = 0;     /* 0 connecting, 1 open, 2 closing, 3 closed */
    this._buf = Buffer.alloc(0);
    this._msg = null;        /* { fin, opcode, chunks: [] } 分片重组 */
    this._closedByUs = false;
  }

  connect(url, headers = {}, timeoutMs = 12000) {
    const u = new URL(url);
    const secure = u.protocol === "wss:";
    const port = +u.port || (secure ? 443 : 80);
    const key = crypto.randomBytes(16).toString("base64");
    const lines = [
      `GET ${u.pathname}${u.search} HTTP/1.1`,
      `Host: ${u.host}`,
      `Upgrade: websocket`,
      `Connection: Upgrade`,
      `Sec-WebSocket-Key: ${key}`,
      `Sec-WebSocket-Version: 13`,
      ...Object.entries(headers).map(([k, v]) => `${k}: ${v}`),
      `\r\n`,
    ];
    const reqText = lines.join("\r\n");
    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = err => { if (!settled) { settled = true; try { this._sock?.destroy(); } catch {} reject(err); } };
      const sock = secure
        ? tls.connect({ host: u.hostname, port, servername: u.hostname })
        : net.connect({ host: u.hostname, port });
      this._sock = sock;
      sock.setNoDelay(true);
      const timer = setTimeout(() => fail(new Error(`连接超时（${timeoutMs}ms）：${u.hostname}`)), timeoutMs);
      sock.on("error", err => { clearTimeout(timer); fail(Object.assign(new Error("网络错误：" + err.message), { network: true })); });
      sock.on("connect", () => sock.write(reqText));

      /* 手写响应头解析（可能分片到达） */
      let headerDone = false;
      sock.on("data", d => {
        if (headerDone) { this._feed(d); return; }
        this._buf = Buffer.concat([this._buf, d]);
        const idx = this._buf.indexOf("\r\n\r\n");
        if (idx < 0) {
          if (this._buf.length > 64 * 1024) { clearTimeout(timer); fail(new Error("握手响应头过大")); }
          return;
        }
        const headText = this._buf.subarray(0, idx).toString("utf8");
        const rest = this._buf.subarray(idx + 4);
        const statusLine = headText.split("\r\n")[0] || "";
        const m = statusLine.match(/HTTP\/1\.[01]\s+(\d{3})\s*(.*)/i);
        const status = m ? +m[1] : 0;
        if (status !== 101) {
          let body = "";
          try { body = rest.toString("utf8").slice(0, 500); } catch {}
          clearTimeout(timer);
          const err = new Error(`握手被拒绝：HTTP ${status}${m?.[2] ? " " + m[2].slice(0, 60) : ""}${body ? " · " + body.replace(/\s+/g, " ").slice(0, 200) : ""}`);
          err.status = status; err.body = body;
          try { sock.destroy(); } catch {}
          if (!settled) { settled = true; reject(err); }
          return;
        }
        headerDone = true;
        clearTimeout(timer);
        if (!settled) { settled = true; this.readyState = 1; resolve(); this.onopen?.(); }
        if (rest.length) this._feed(rest);
      });
      sock.on("close", () => {
        this.readyState = 3;
        this.onclose?.();
      });
    });
  }

  _feed(d) {
    this._buf = Buffer.concat([this._buf, d]);
    for (;;) {
      const fr = this._parseFrame();
      if (!fr) return;
      this._handleFrame(fr);
      if (this.readyState >= 2) return;
    }
  }

  _parseFrame() {
    const buf = this._buf;
    if (buf.length < 2) return null;
    const fin = (buf[0] & 0x80) !== 0;
    const opcode = buf[0] & 0x0f;
    const masked = (buf[1] & 0x80) !== 0;
    let len = buf[1] & 0x7f;
    let off = 2;
    if (len === 126) { if (buf.length < 4) return null; len = buf.readUInt16BE(2); off = 4; }
    else if (len === 127) { if (buf.length < 10) return null; const big = buf.readBigUInt64BE(2); if (big > 64n * 1024n * 1024n) { this._teardown(); return null; } len = Number(big); off = 10; }
    let mask = null;
    if (masked) { if (buf.length < off + 4) return null; mask = buf.subarray(off, off + 4); off += 4; }
    if (buf.length < off + len) return null;
    let payload = buf.subarray(off, off + len);
    if (mask) {
      const un = Buffer.from(payload);
      for (let i = 0; i < un.length; i++) un[i] ^= mask[i & 3];
      payload = un;
    }
    this._buf = buf.subarray(off + len);
    return { fin, opcode, payload };
  }

  _handleFrame({ fin, opcode, payload }) {
    if (opcode === 0x8) { /* close */
      this._teardown();
      return;
    }
    if (opcode === 0x9) { this._sendRaw(0xA, payload); return; } /* ping → pong */
    if (opcode === 0xA) return; /* pong */
    if (opcode === 0x1 || opcode === 0x2) {
      if (fin) { this.onmessage?.(payload); return; }
      this._msg = { opcode, chunks: [payload] };
      return;
    }
    if (opcode === 0x0 && this._msg) {
      this._msg.chunks.push(payload);
      if (fin) { const full = Buffer.concat(this._msg.chunks); this._msg = null; this.onmessage?.(full); }
    }
  }

  _maskFrame(opcode, payload) {
    const mask = crypto.randomBytes(4);
    const masked = Buffer.from(payload);
    for (let i = 0; i < masked.length; i++) masked[i] ^= mask[i & 3];
    const head = [0x80 | opcode];
    const len = payload.length;
    if (len < 126) head.push(0x80 | len);
    else if (len < 65536) { head.push(0x80 | 126, (len >> 8) & 0xff, len & 0xff); }
    else { const b = Buffer.alloc(8); b.writeBigUInt64BE(BigInt(len)); head.push(0x80 | 127, ...b); }
    return Buffer.concat([Buffer.from(head), mask, masked]);
  }

  _sendRaw(opcode, payload) {
    if (this.readyState !== 1) return false;
    try { this._sock.write(this._maskFrame(opcode, payload)); return true; } catch { return false; }
  }

  /** 发二进制消息（自动分片 >8MB） */
  send(buf) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
    if (data.length <= 8 * 1024 * 1024) return this._sendRaw(0x2, data);
    let off = 0, first = true;
    while (off < data.length) {
      const piece = data.subarray(off, Math.min(data.length, off + 4 * 1024 * 1024));
      this._sendRaw(first ? 0x2 : 0x0, piece);
      first = false; off += piece.length;
    }
    return true;
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    const r = Buffer.from(reason, "utf8");
    const p = Buffer.alloc(2 + r.length);
    p.writeUInt16BE(code, 0); r.copy(p, 2);
    try { this._sock.write(this._maskFrame(0x8, p)); } catch {}
    setTimeout(() => this._teardown(), 1200);
  }

  _teardown() {
    if (this.readyState === 3) return;
    this.readyState = 3;
    try { this._sock?.end(); } catch {}
    try { this._sock?.destroy(); } catch {}
  }
}
