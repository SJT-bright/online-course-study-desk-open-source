/**
 * 豆包流式语音识别 2.0（火山引擎）WebSocket 客户端 — 零依赖
 *
 * 协议依据（官方文档，2026-09 核对）：
 *   端点      wss://openspeech.bytedance.com/api/v3/sauc/bigmodel（双向流式，实时字幕场景）
 *   资源 ID   volc.seedasr.sauc.duration  豆包流式语音识别模型 2.0 · 小时版（推荐）
 *             volc.seedasr.sauc.concurrent 2.0 · 并发版
 *             volc.bigasr.sauc.duration    1.0 · 小时版
 *             volc.bigasr.sauc.concurrent  1.0 · 并发版
 *   鉴权      握手头 X-Api-Key（控制台>API Key管理 获取）
 *   帧        大端序 4 字节头 + 可选 event/sequence + 4 字节 payload 长度 + payload(gzip)
 *
 * 帧头：byte0 = protocol_version(4bit)|header_size(4bit, 单位4字节)
 *       byte1 = message_type(4bit)|flags(4bit)
 *       byte2 = serialization(4bit)|compression(4bit)
 *       byte3 = 保留
 */
import { gzipSync, gunzipSync } from "node:zlib";
import { RawWebSocket } from "./ws-raw.mjs";
import { randomUUID } from "node:crypto";

export const DOUBAO_WS_URL = "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel";
export const DEFAULT_RESOURCE_ID = "volc.seedasr.sauc.duration";
export const RESOURCE_LABELS = {
  "volc.seedasr.sauc.duration": "豆包流式语音识别 2.0 · 小时版",
  "volc.seedasr.sauc.concurrent": "豆包流式语音识别 2.0 · 并发版",
  "volc.bigasr.sauc.duration": "豆包流式语音识别 1.0 · 小时版",
  "volc.bigasr.sauc.concurrent": "豆包流式语音识别 1.0 · 并发版",
};

const PROTOCOL_VERSION = 0b0001;
const HEADER_SIZE = 0b0001;
const FULL_CLIENT_REQUEST = 0b0001;
const AUDIO_ONLY_REQUEST = 0b0010;
const FULL_SERVER_RESPONSE = 0b1001;
const ERROR_INFO = 0b1111;
const SER_RAW = 0b0000;
const SER_JSON = 0b0001;
const COMP_NONE = 0b0000;
const COMP_GZIP = 0b0001;

function frameWith(payload, messageType, flags, serialization, compression) {
  const header = Buffer.from([
    (PROTOCOL_VERSION << 4) | HEADER_SIZE,
    (messageType << 4) | flags,
    (serialization << 4) | compression,
    0x00,
  ]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(payload.length, 0);
  return Buffer.concat([header, len, payload]);
}

function decodeFrame(buf) {
  if (buf.length < 4) throw new Error("帧过短");
  let off = 1;
  const b1 = buf[off++];
  const messageType = (b1 >> 4) & 0x0f;
  const flags = b1 & 0x0f;
  const b2 = buf[off++];
  const serialization = (b2 >> 4) & 0x0f;
  const compression = b2 & 0x0f;
  off += 1;
  let sequence = null;
  if (flags & 0b0001) { if (off + 4 > buf.length) throw new Error("sequence 越界"); sequence = buf.readInt32BE(off); off += 4; }
  if (flags & 0b0010) off += 4;
  if (off + 4 > buf.length) throw new Error("payload 长度越界");
  const payloadSize = buf.readUInt32BE(off); off += 4;
  const payload = buf.subarray(off, off + payloadSize);
  return { messageType, flags, serialization, compression, sequence, payload };
}

/** 把火山侧错误翻译成人话 + 处置建议 */
export function friendlyAsrError(raw) {
  const s = String(raw || "");
  const low = s.toLowerCase();
  if (low.includes("401") || low.includes("unauthorized") || low.includes("invalid api key") || low.includes("authenticate"))
    return { kind: "auth", hint: "API Key 无效或未通过鉴权。请到火山引擎控制台「API Key 管理」重新生成，并确认已开通豆包流式语音识别模型。" };
  if (low.includes("403") || low.includes("forbidden"))
    return { kind: "auth", hint: "服务拒绝访问（403）。通常是该 API Key 未开通对应的语音识别资源，或资源 ID 选错。请在控制台开通「豆包流式语音识别模型」后重试。" };
  if (low.includes("429") || low.includes("rate limit") || low.includes("quota") || low.includes("exceed") || low.includes("并发"))
    return { kind: "quota", hint: "请求被限流或额度用尽（429）。请到火山引擎控制台确认余额/资源包，稍后可点「补转写」从本地音频缓存恢复。" };
  if (low.includes("enotfound") || low.includes("econnrefused") || low.includes("etimedout") || low.includes("fetch failed") || low.includes("network") || low.includes("getaddrinfo"))
    return { kind: "network", hint: "网络连接失败。请检查本机网络/代理；录音已在本地缓存，恢复后可补转写，不会丢稿。" };
  return { kind: "unknown", hint: "" };
}

/**
 * 一路豆包流式识别会话（双向流式端点）。
 * 事件回调（覆写属性即可）：onPartial / onFinal / onError / onClose
 *   onPartial({ text, t0, t1, speaker })   当前正在说的句子（未定稿）
 *   onFinal({ text, t0, t1, speaker })     已定稿分句（每个只回调一次）
 *   onError({ message, hint, kind, fatal })  fatal=true 表示会话终止
 *   onClose()
 */
export class DoubaoAsrSession {
  constructor(opts = {}) {
    this.apiKey = opts.apiKey || "";
    this.resourceId = opts.resourceId || DEFAULT_RESOURCE_ID;
    this.url = opts.url || DOUBAO_WS_URL;
    this.language = opts.language || "";          /* 空 = 自动（支持中英+方言） */
    this.speakerInfo = !!opts.speakerInfo;
    this.sampleRate = opts.sampleRate || 16000;
    this.uid = opts.uid || randomUUID();
    this.onPartial = null; this.onFinal = null; this.onError = null; this.onClose = null;
    this.ws = null;
    this.finalized = new Set();    /* 已定稿分句下标（1-based），防重复 */
    this.liveIndex = 0;
    this.closedByUs = false;
    this.lastError = null;
    this.bytesSent = 0;
    this.startedAt = 0;
  }

  connect(timeoutMs = 12000) {
    return new Promise((resolve, reject) => {
      if (!this.apiKey) return reject(Object.assign(new Error("尚未配置豆包 API Key"), { kind: "config" }));
      const ws = new RawWebSocket();
      this.ws = ws;
      let opened = false;
      ws.onopen = () => {
        opened = true;
        try { ws.send(this.buildInitFrame()); } catch {}
        this.startedAt = Date.now();
        resolve();
      };
      ws.onmessage = buf => { this.handleMessage(buf).catch(() => {}); };
      ws.onerror = e => {
        const raw = e?.status ? `HTTP ${e.status} ${e.body || ""}` : (e?.message || "网络错误");
        if (!opened) {
          const f = friendlyAsrError(raw);
          const err = new Error(
            f.kind === "auth" ? "豆包语音服务鉴权未通过（" + raw + "）" :
            f.kind === "quota" ? "豆包语音服务拒绝请求（" + raw + "）" :
            "连接豆包语音服务失败：" + raw
          );
          err.hint = f.hint; err.kind = f.kind;
          if (e?.network) err.kind = "network";
          reject(err);
        } else {
          const f = friendlyAsrError(raw);
          const err = new Error("连接中断：" + raw);
          err.hint = f.hint; err.kind = f.kind; err.fatal = true;
          this.lastError = err;
          this.onError?.(err);
        }
      };
      ws.onclose = () => {
        if (!opened) {
          reject(new Error("连接在握手前关闭"));
          return;
        }
        this.onClose?.(this.lastError);
      };
      ws.connect(this.url, {
        "X-Api-Key": this.apiKey,
        "X-Api-Resource-Id": this.resourceId,
        "X-Api-Request-Id": randomUUID(),
        "X-Api-Connect-Id": randomUUID(),
        "X-Api-Sequence": "-1",
      }, timeoutMs).catch(reject);
    });
  }

  buildInitFrame() {
    const request = {
      model_name: "bigmodel",
      enable_itn: true,
      enable_punc: true,
      enable_ddc: false,
      show_utterances: true,
      result_type: "full",
    };
    if (this.language) request.language = this.language;
    if (this.speakerInfo) { request.enable_speaker_info = true; request.ssd_version = "200"; }
    const payload = {
      user: { uid: this.uid },
      audio: { format: "pcm", codec: "raw", rate: this.sampleRate, bits: 16, channel: 1 },
      request,
    };
    return frameWith(gzipSync(Buffer.from(JSON.stringify(payload), "utf8")), FULL_CLIENT_REQUEST, 0, SER_JSON, COMP_GZIP);
  }

  /** 发送 16k/16bit/单声道 PCM 原始字节 */
  sendAudio(pcm) {
    const ws = this.ws;
    if (!ws || ws.readyState !== 1) return false;
    try { ws.send(frameWith(gzipSync(Buffer.from(pcm)), AUDIO_ONLY_REQUEST, 0, SER_RAW, COMP_GZIP)); this.bytesSent += pcm.length; return true; }
    catch { return false; }
  }

  async handleMessage(data) {
    const buf = Buffer.isBuffer(data) ? data : Buffer.from(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    let fr;
    try { fr = decodeFrame(buf); } catch { return; }
    if (fr.messageType === ERROR_INFO) {
      let detail = "";
      try { const raw = fr.compression === COMP_GZIP ? gunzipSync(fr.payload) : fr.payload; detail = raw.toString("utf8"); } catch { detail = "(无法解码错误帧)"; }
      const f = friendlyAsrError(detail);
      const err = new Error("豆包识别错误：" + detail);
      err.hint = f.hint; err.kind = f.kind; err.fatal = true;
      this.lastError = err;
      this.onError?.(err);
      return;
    }
    if (fr.messageType !== FULL_SERVER_RESPONSE || fr.serialization !== SER_JSON) return;
    let body;
    try { const raw = fr.compression === COMP_GZIP ? gunzipSync(fr.payload) : fr.payload; body = JSON.parse(raw.toString("utf8")); }
    catch { return; }
    if (body?.code && body.code !== 0) {
      const f = friendlyAsrError(`${body.code} ${body.message || ""}`);
      const err = new Error(`豆包识别错误 ${body.code}: ${body.message || ""}`);
      err.hint = f.hint; err.kind = f.kind; err.fatal = true;
      this.lastError = err;
      this.onError?.(err);
      return;
    }
    const result = body?.result;
    if (!result) return;
    const utts = Array.isArray(result.utterances) ? result.utterances : [];
    const isDef = u => u?.definite === true || u?.def === true || u?.definite === 1 || u?.def === 1;
    const spk = u => (typeof u?.speaker === "string" ? u.speaker : (typeof u?.additions?.speaker_id === "string" ? u.additions.speaker_id : null));
    for (let i = 0; i < utts.length; i++) {
      const u = utts[i];
      if (!isDef(u)) continue;
      const idx = i + 1;
      if (this.finalized.has(idx)) continue;
      this.finalized.add(idx);
      this.liveIndex = Math.max(this.liveIndex, idx);
      this.onFinal?.({
        text: String(u?.text ?? ""),
        t0: +u?.start_time || 0, t1: +u?.end_time || 0,
        speaker: spk(u),
      });
    }
    const liveIdx = utts.reduce((acc, u, i) => isDef(u) ? acc : i, -1);
    let partial = null;
    if (liveIdx >= 0) partial = String(utts[liveIdx]?.text ?? "");
    else if (utts.length === 0 && typeof result.text === "string" && result.text) partial = result.text;
    if (partial && partial.trim()) {
      const u = liveIdx >= 0 ? utts[liveIdx] : null;
      this.onPartial?.({
        text: partial,
        t0: +(u?.start_time) || 0, t1: +(u?.end_time) || 0,
        speaker: u ? spk(u) : null,
      });
    }
  }

  /** 主动结束：等服务端回包/回关一小会儿再关 */
  async finish(waitMs = 2500) {
    const ws = this.ws;
    if (!ws) return;
    await new Promise(resolve => {
      const timer = setTimeout(resolve, waitMs);
      ws.onclose = () => { clearTimeout(timer); resolve(); };
      try { ws.close(1000, "client done"); } catch { clearTimeout(timer); resolve(); }
    });
  }

  /** 立即断开（异常兜底） */
  abort() {
    this.closedByUs = true;
    try { this.ws?._teardown(); } catch {}
  }
}
