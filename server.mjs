#!/usr/bin/env node
/**
 * 网课学习工作台 - 本地服务
 * 双击「启动工作台.command」即可。只监听 127.0.0.1，不对外。
 *
 * 提供：
 *   GET  /                     学习台页面
 *   GET  /api/list?dir=...     浏览文件夹（默认 ~/Downloads）
 *   GET  /api/media?path=...   视频流（支持 Range 拖动）
 *   GET  /api/bili-check       yt-dlp / ffmpeg 状态
 *   POST /api/bilibili         B站视频下载（SSE 进度）
 *   GET  /api/feishu-check     lark-cli 与飞书登录状态
 *   POST /api/feishu/resolve   识别飞书链接类型
 *   POST /api/feishu/import    下载飞书妙记 / 文件 / 导出文档（SSE）
 *   GET  /api/notes/*          笔记数据库（~/.study-desk/notes.db，SQLite）
 *   GET  /api/search?q=        笔记、转写与资产库联合搜索
 *   *   /api/proxy/*           网页兼容模式反向代理（小鹅通 / 腾讯会议回放等）
 */
import http from "node:http";
import crypto from "node:crypto";
import dns from "node:dns";
import fs, { statSync, readdirSync, existsSync, createReadStream, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { parseFeishuUrl } from "./feishu-url.mjs";
import { removeFeishuVideo } from "./lib/feishu-downloads.mjs";
import { findDocumentVideo } from "./lib/feishu-doc-video.mjs";
import { McpClient, McpStdioTransport, McpHttpTransport, splitCommandLine } from "./lib/mcp-client.mjs";
import { parseProxyPath, upstreamUrl, rewriteHtml, rewriteCss, rewriteJs, rewriteJson, rewriteM3u8, rewriteVtt, rewriteLocation, isPrivateHost, isXiaoeHost, hostInScope, PROXY_API_PREFIX } from "./lib/url-rewrite.mjs";
import { CookieJar } from "./lib/cookie-jar.mjs";
import { bridgeScript } from "./lib/proxy-bridge.mjs";
import { openReviewQueue } from "./lib/review-queue.mjs";
import { openRecentLinks } from "./lib/recent-links.mjs";
import { toolPath, toolEnv, openSystem } from "./lib/platform.mjs";
import { appDataResolver } from "./lib/app-data-migration.mjs";

/* 笔记数据库：Node 22.5+ 内置 SQLite；旧版本自动降级为「仅浏览器存储」 */
let DatabaseSync = null;
try { ({ DatabaseSync } = await import("node:sqlite")); } catch {}

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = __dirname;
const resolveStoredPath = appDataResolver(ROOT);
const PORT = Number(process.env.STUDYDESK_PORT) || 8790;
const HOST = "127.0.0.1";
const HOME = process.env.STUDYDESK_HOME || os.homedir();   /* 测试可用 STUDYDESK_HOME 隔离用户数据目录 */
const TOOLS = path.join(ROOT, "tools");
const YTDLP = process.env.STUDYDESK_YTDLP || toolPath(["yt-dlp"], { envName: "STUDYDESK_YTDLP" }) || path.join(TOOLS, process.platform === "win32" ? "yt-dlp.exe" : "yt-dlp_macos");
const COOKIE_FILE = existsSync(resolveStoredPath(path.join(TOOLS, "bili-cookies.txt"))) ? resolveStoredPath(path.join(TOOLS, "bili-cookies.txt")) : path.join(HOME, '.study-desk', 'bili-cookies.txt');
/* 本地 Whisper 精转（离线、不上传） */
const WHISPER_MODEL_DIR = process.env.STUDYDESK_MODEL_DIR || resolveStoredPath(path.join(TOOLS, "models"));
const WHISPER_MODELS = {
  base:  { file: "ggml-base.bin",  url: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-base.bin",  approx: 148000000, label: "base · 快" },
  small: { file: "ggml-small.bin", url: "https://hf-mirror.com/ggerganov/whisper.cpp/resolve/main/ggml-small.bin", approx: 466000000, label: "small · 更准" },
};
function findWhisperBin() { return toolPath(["whisper-cli", "whisper-cpp"], { envName: "STUDYDESK_WHISPER" }); }
const DOWNLOAD_DIR = process.env.STUDYDESK_DOWNLOAD_DIR || resolveStoredPath(path.join(ROOT, "downloads"));
/* ═══════════════ 豆包语音转写（火山引擎官方 API） ═══════════════ */
const { randomUUID } = crypto;   /* 豆包会话/临时文件 ID */

/* ─── 背景 DIY（沉浸模式壁纸） ─── */
const BG_DIR = path.join(HOME, ".study-desk", "wallpaper");
const BG_EXTS = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp", ".gif": "image/gif" };
function bgList() {
  try {
    return fs.readdirSync(BG_DIR).filter(f => BG_EXTS[path.extname(f).toLowerCase()])
      .map(f => ({ name: f, mtime: statSync(path.join(BG_DIR, f)).mtimeMs }));
  } catch { return []; }
}

import { DoubaoAsrSession, DEFAULT_RESOURCE_ID as DOUBAO_DEFAULT_RES, RESOURCE_LABELS as DOUBAO_RES_LABELS, friendlyAsrError } from "./lib/doubao-asr.mjs";
import { whisperTranscribeFile } from "./lib/whisper-file.mjs";
import { biliAsrStatus, transcribeBiliAudio, fullDurationSec } from "./lib/bili-transcript.mjs";
import { allocateSessionDir, discardSessionFile, pipeSessionDownload } from "./lib/session-media.mjs";
import { openLocalWindow } from "./lib/desktop-window.mjs";
import { appDocumentAllowed, APP_ONLY_HTML } from "./lib/app-shell.mjs";
import { LOCAL_ASR_FILES, LOCAL_ASR_MODEL, LOCAL_ASR_REVISION, localAsrRuntimeReady, localAsrModelReady, startLocalAsr } from "./lib/local-asr.mjs";
const DOUBAO_CFG = path.join(HOME, ".study-desk", "doubao.json");
const reviewQueue = openReviewQueue(path.join(HOME, ".study-desk", "review-cards.json"));
const recentLinks = openRecentLinks(path.join(HOME, '.study-desk', 'recent-links.json'));
/* ─────────── 学习资产库本机桥（127.0.0.1:8791，学习资产库应用提供） ─────────── */
const VAULT_PORT = Number(process.env.STUDYDESK_VAULT_PORT) || 8791;
const VAULT_BASE = `http://127.0.0.1:${VAULT_PORT}`;
const vaultFetch = (p, opts = {}) => {
  const t = opts.timeoutMs || 6000;
  return fetch(VAULT_BASE + p, { ...opts, signal: AbortSignal.timeout(t), headers: { ...(opts.headers || {}) } });
};
async function vaultProxy(res, url, init) {
  try {
    const r = await vaultFetch(url, init);
    const body = await r.text();
    res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
    return res.end(body);
  } catch (e) {
    const msg = e?.name === "TimeoutError" ? "学习资产库连接超时（应用可能在启动中）" : "无法连接学习资产库（8791）——请确认「学习资产库」应用正在运行";
    return json(res, 502, { error: msg });
  }
}
const STT_DIR = process.env.STUDYDESK_TRANSCRIPTS_DIR || path.join(DOWNLOAD_DIR, "transcripts");
const DOUBAO_SESSIONS = new Map();   /* id → { session, queue, busy, closed, meta, cache } */
const LOCAL_ASR_DIR = path.join(HOME, ".study-desk", "models", "streaming-paraformer-zh-en");
const LOCAL_ASR_SESSIONS = new Map();
const BILI_TRANSCRIPT_JOBS = new Map();
let biliTranscriptQueue = Promise.resolve();
let localAsrDownloading = false;

async function localAsrStartSession(meta) {
  const sid = randomUUID(), id = randomUUID();
  const rec = {
    id, source: meta.source, sourceLabel: meta.sourceLabel, title: meta.title,
    sourceKey: String(meta.sourceKey || "").slice(0, 1200), pageUrl: meta.pageUrl, startedAt: Date.now(), endedAt: null, durationMs: 0,
    lines: [], status: "recording", engine: "sherpa-onnx",
    resourceId: LOCAL_ASR_MODEL, dir: null, errorMessage: "", hint: "",
  };
  const jsonl = path.join(STT_DIR, id + ".jsonl");
  let session;
  let doneResolve;
  const done = new Promise(resolve => { doneResolve = resolve; });
  let lastPartial = "";
  const worker = startLocalAsr(LOCAL_ASR_DIR, event => {
    if (event.type === "partial") {
      if (event.text !== lastPartial) {
        lastPartial = event.text;
        broadcastStt({ type: "stt-partial", sid, id, text: event.text, t0: event.t0, t1: event.t1 });
      }
    } else if (event.type === "final" && event.text?.trim()) {
      lastPartial = "";
      const line = { kind: "final", text: event.text.trim(), t0: event.t0, t1: event.t1, wall: Date.now() };
      rec.lines.push(line);
      fs.appendFileSync(jsonl, JSON.stringify(line) + "\n");
      sttUpd(id, { lines: rec.lines, durationMs: event.t1 });
      broadcastStt({ type: "stt-final", sid, id, ...line });
    } else if (event.type === "error") {
      rec.status = "error"; rec.errorMessage = event.message;
      sttUpd(id, { status: "error", endedAt: Date.now(), errorMessage: event.message, text: rec.lines.map(line => line.text).join("\n") });
      LOCAL_ASR_SESSIONS.delete(sid);
      broadcastStt({ type: "stt-error", sid, id, message: event.message, fatal: true });
      doneResolve();
    } else if (event.type === "done") doneResolve();
  });
  try { await worker.started; }
  catch (error) { worker.kill(); throw error; }
  mkdirSync(STT_DIR, { recursive: true });
  fs.writeFileSync(jsonl, "", "utf8");
  sttWriteAll([...sttReadAll(), rec]);
  session = { id, rec, worker, done };
  LOCAL_ASR_SESSIONS.set(sid, session);
  return { ok: true, sid, id, engine: "sherpa-onnx" };
}

function doubaoReadConfig() {
  try { return JSON.parse(fs.readFileSync(DOUBAO_CFG, "utf8")); }
  catch { return { apiKey: "", resourceId: DOUBAO_DEFAULT_RES, language: "", speakerInfo: true, hotwords: "" }; }
}
function doubaoWriteConfig(cfg) {
  mkdirSync(path.dirname(DOUBAO_CFG), { recursive: true });
  fs.writeFileSync(DOUBAO_CFG, JSON.stringify(cfg, null, 2), "utf8");
  try { fs.chmodSync(DOUBAO_CFG, 0o600); } catch {}
}
const doubaoKeyConfigured = () => !!doubaoReadConfig().apiKey;

/* 音频重采样到 16k/16bit/单声道 —— 线性插值，足够语音识别用 */
function resampleTo16k(f32) {
  const from = f32.sampleRate, to = 16000;
  if (from === to) return f32.data;
  const ratio = from / to;
  const outLen = Math.max(1, Math.floor(f32.data.length / ratio));
  const out = new Float32Array(outLen);
  for (let i = 0; i < outLen; i++) {
    const pos = i * ratio, i0 = Math.floor(pos), frac = pos - i0;
    const a = f32.data[i0] || 0, b = f32.data[i0 + 1] ?? a;
    out[i] = a + (b - a) * frac;
  }
  return out;
}
function f32ToPcm16(f32) {
  const out = Buffer.alloc(f32.length * 2);
  for (let i = 0; i < f32.length; i++) {
    let s = Math.max(-1, Math.min(1, f32[i]));
    out.writeInt16LE(Math.round(s * 32767), i * 2);
  }
  return out;
}
/* 客户端上传的 Float32 JSON（可能分块）合并为 PCM；也直接接受 base64 PCM */
function clientAudioToPcm(audio) {
  if (audio?.pcmBase64) return Buffer.from(audio.pcmBase64, "base64");
  if (audio?.float32 && Array.isArray(audio.float32.data)) {
    const f32 = resampleTo16k({ data: audio.float32.data, sampleRate: audio.float32.sampleRate || 48000 });
    return f32ToPcm16(f32);
  }
  return null;
}

/* 台账存取：JSON 文件 + 原子写 */
function sttReadAll() {
  try { return JSON.parse(fs.readFileSync(path.join(STT_DIR, "index.json"), "utf8")); }
  catch { return []; }
}
function sttWriteAll(list) {
  mkdirSync(STT_DIR, { recursive: true });
  const tmp = path.join(STT_DIR, ".index.tmp");
  fs.writeFileSync(tmp, JSON.stringify(list, null, 2), "utf8");
  fs.renameSync(tmp, path.join(STT_DIR, "index.json"));
}
function sttUpd(id, patch) {
  const list = sttReadAll();
  const it = list.find(x => x.id === id);
  if (it) Object.assign(it, patch);
  sttWriteAll(list);
  return it;
}
/* 转写自动分章：显式信号词 + 时间间隔（≥8 分钟）双启发式，纯规则不用 LLM */
const STT_CH_SIG_RE = /^(?:第[一二三四五六七八九十0-9]+[章节讲部分]|接下来(?:我们)?(?:讲|学习|看)|今天(?:我们)?(?:讲|学)|总结(?:一下)?[，,。]?|最后[，,])/;
function detectChapters(it) {
  const lines = (it.lines || []).filter(l => typeof l.text === "string" && l.text.trim());
  if (!lines.length) return [];
  const GAP_MS = 8 * 60 * 1000;
  const cuts = [];
  let prevT1 = null;
  for (let i = 0; i < lines.length; i++){
    const l = lines[i];
    const isSig = STT_CH_SIG_RE.test(l.text.trim());
    const isGap = prevT1 !== null && (l.t0 || 0) - prevT1 >= GAP_MS;
    if (i > 0 && (isSig || isGap)){
      cuts.push({
        lineIdx: i,
        t0: l.t0 || 0,
        signal: isSig,
        title: isSig ? l.text.trim().replace(/\s+/g, " ").slice(0, 18) : null,
      });
    }
    prevT1 = Math.max(prevT1 || 0, l.t1 || l.t0 || 0);
  }
  const stampMs = t => { const s = Math.max(0, Math.round((t || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
  if (!cuts.length) return [{
    title: (lines[0].text || "").trim().replace(/\s+/g, " ").slice(0, 18) || "全文",
    t0: lines[0].t0 || 0,
    t1: lines[lines.length - 1].t1 || lines[lines.length - 1].t0 || 0,
    lineIdx: [0, lines.length],
  }];
  const chapters = cuts.map((c, k) => {
    const start = c.lineIdx, end = (k + 1 < cuts.length ? cuts[k + 1].lineIdx : lines.length);
    const title = c.signal ? c.title : `第 ${k + 2} 部分 ${stampMs(c.t0)}`;
    return { title, t0: c.t0, t1: lines[end - 1].t1 || lines[end - 1].t0 || 0, lineIdx: [start, end] };
  });
  chapters.unshift({
    title: (lines[0].text || "").trim().replace(/\s+/g, " ").slice(0, 18) || "开头",
    t0: lines[0].t0 || 0,
    t1: lines[cuts[0].lineIdx - 1].t1 || lines[cuts[0].lineIdx - 1].t0 || 0,
    lineIdx: [0, cuts[0].lineIdx],
  });
  return chapters;
}
const fmtTsdur = ms => {
  const s = Math.max(0, Math.round(ms / 1000));
  return `${String(Math.floor(s / 3600)).padStart(2, "0")}:${String(Math.floor(s % 3600 / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

/* 会话：喂 PCM → 排队送豆包；实时落台账 JSONL；异常降级缓存 */
function doubaoFeed(sid, pcm) {
  const S = DOUBAO_SESSIONS.get(sid);
  if (!S || S.closed) return;
  S.queue.push(pcm);
  S.cache.push(pcm);
  if (S.cache.length > 24000) S.cache.splice(0, S.cache.length - 24000); /* 缓存上限 ~48 分钟音频，防内存爆 */
  S.bytes += pcm.length;
  pump(sid);
}
function pump(sid) {
  const S = DOUBAO_SESSIONS.get(sid);
  if (!S || S.busy || S.closed) return;
  const chunk = S.queue.shift();
  if (!chunk) return;
  S.busy = true;
  try {
    if (!S.session.sendAudio(chunk)) S.queue.unshift(chunk); /* 未就绪，稍后再试 */
  } finally { S.busy = false; }
  setImmediate(() => pump(sid));
}

async function doubaoStartSession(meta) {
  const cfg = doubaoReadConfig();
  const pasteMode = meta.source === "browser";   /* 豆包 APP 粘贴路线：本地免费，不需要 Key */
  if (!pasteMode && !cfg.apiKey) {
    const e = new Error("尚未配置豆包 API Key，请先在「转写」面板的设置里填入");
    e.kind = "config"; throw e;
  }
  const sid = randomUUID();
  const session = new DoubaoAsrSession({
    apiKey: cfg.apiKey, resourceId: cfg.resourceId || DOUBAO_DEFAULT_RES,
    language: cfg.language || "", speakerInfo: !!cfg.speakerInfo, sampleRate: 16000,
  });
  const id = meta.id || randomUUID();
  const rec = {
    id, source: meta.source || "mic", sourceLabel: meta.sourceLabel || "",
    title: meta.title || "未命名", sourceKey: String(meta.sourceKey || "").slice(0, 1200), pageUrl: meta.pageUrl || "",
    startedAt: Date.now(), endedAt: null, durationMs: 0,
    lines: [], status: "recording", engine: "doubao",
    resourceId: session.resourceId, dir: null, errorMessage: "", hint: "",
  };
  mkdirSync(STT_DIR, { recursive: true });
  sttWriteAll([...sttReadAll(), rec]);
  const jsonl = path.join(STT_DIR, id + ".jsonl");
  fs.writeFileSync(jsonl, "", "utf8");
  const S = { id, session, queue: [], cache: [], busy: false, closed: false, bytes: 0, jsonl, rec, rawCache: [] };
  DOUBAO_SESSIONS.set(sid, S);
  session.onPartial = p => {
    if (!p.text.trim()) return;
    const line = { kind: "partial", text: p.text.trim(), t0: p.t0, t1: p.t1, speaker: p.speaker, wall: Date.now() };
    S.lastPartial = line;
  };
  session.onFinal = f => {
    if (!f.text.trim()) return;
    const line = { kind: "final", text: f.text.trim(), t0: f.t0, t1: f.t1, speaker: f.speaker, wall: Date.now() };
    fs.appendFileSync(jsonl, JSON.stringify(line) + "\n");
    rec.lines.push(line);
    sttUpd(id, { lines: rec.lines, durationMs: Math.max(rec.durationMs, f.t1 || 0) });
  };
  session.onError = err => {
    const f = friendlyAsrError(err.message);
    rec.status = "error";
    rec.errorMessage = err.message;
    rec.hint = err.hint || f.hint || "";
    sttUpd(id, { status: "error", errorMessage: rec.errorMessage, hint: rec.hint });
    broadcastStt({ type: "stt-error", id, sid, message: rec.errorMessage, hint: rec.hint, kind: err.kind || f.kind, fatal: !!err.fatal });
  };
  session.onClose = () => {
    S.closed = true;
    DOUBAO_SESSIONS.delete(sid);
    broadcastStt({ type: "stt-closed", id, sid });
  };
  if (meta.source === "browser") {
    /* 豆包 APP 粘贴路线：不需要 API Key，不连接云端 */
    DOUBAO_SESSIONS.set(sid, S);
    S.closed = true;
    sttUpd(id, { status: "recording", engine: "doubao-app" });
    return { ok: true, sid, id, resourceId: "豆包APP粘贴" };
  }
  try {
    await session.connect();
    sttUpd(id, { status: "recording" });
    return { ok: true, sid, id, resourceId: session.resourceId };
  } catch (e) {
    DOUBAO_SESSIONS.delete(sid);
    rec.status = "error";
    rec.errorMessage = e.message;
    rec.hint = e.hint || friendlyAsrError(e.message).hint;
    sttUpd(id, { status: "error", errorMessage: rec.errorMessage, hint: rec.hint });
    const err = new Error(e.message); err.hint = e.hint || rec.hint; err.kind = e.kind;
    throw err;
  }
}

/* 台账 SSE 群发（同一进程内保存订阅者） */
const STT_SSE = new Set();
function broadcastStt(obj) {
  const data = `data: ${JSON.stringify(obj)}\n\n`;
  for (const r of STT_SSE) { try { r.write(data); } catch {} }
}
/* ═══════ 豆包 APP 导出目录监听：~/Doubao/chats 新文件 → 自动入台账 ═══════ */
const DOUBAO_CHATS_DIR = path.join(HOME, "Doubao", "chats");
const WATCH_STATE = path.join(STT_DIR, "doubao-watch.json");
const TEXT_EXTS = new Set([".txt", ".md", ".json", ".srt", ".vtt", ".html"]);

function watchStateRead() {
  try { return JSON.parse(fs.readFileSync(WATCH_STATE, "utf8")); }
  catch { return { seen: {} }; }   /* seen: 相对路径 → { mtime, size, imported } */
}
function watchStateWrite(st) {
  try {
    const tmp = WATCH_STATE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(st), "utf8");
    fs.renameSync(tmp, WATCH_STATE);
  } catch {}
}

/* 从文件名/内容猜标题与语言 */
function guessTitleFromName(name) {
  return name.replace(/\.[^.]+$/, "").replace(/[_-]*\d{8,}.*$/, "").trim() || "豆包转写";
}
function parseTimestampedLine(line) {
  /* 支持 [00:11 - 00:12] 文本 / [00:11] 文本 / 00:11 文本 */
  const m = line.match(/^\[?(\d{1,2}:\d{2}(?::\d{2})?)\s*(?:[-–—~]\s*(\d{1,2}:\d{2}(?::\d{2})?))?\]?\s*(.*)$/);
  if (!m) return null;
  const toMs = s => { const p = s.split(":").map(Number); return (p.length === 3 ? p[0] * 3600 : p[0] * 60 + (p.length === 3 ? p[1] : p[1]) * 0 + p[1] * 60 + p[2]) * 1000; };
  const toMs2 = s => { const p = s.split(":").map(Number); if (p.length === 3) return (p[0] * 3600 + p[1] * 60 + p[2]) * 1000; return (p[0] * 60 + p[1]) * 1000; };
  return { t0: m[1] ? toMs2(m[1]) : 0, t1: m[2] ? toMs2(m[2]) : 0, text: (m[3] || "").trim() };
}
function parseSrtTime(s) {
  const m = s.trim().match(/(\d{1,2}):(\d{2}):(\d{2})[,.](\d{1,3})/);
  if (!m) return 0;
  return (+m[1] * 3600 + +m[2] * 60 + +m[3]) * 1000 + +m[4];
}

function doubaoLinesFromFile(file) {
  const ext = path.extname(file.name).toLowerCase();
  const raw = fs.readFileSync(file.abs, "utf8");
  const lines = [];
  if (ext === ".json") {
    try {
      const j = JSON.parse(raw);
      const subs = Array.isArray(j) ? j : (j.subtitles || []);
      for (const s of subs) {
        if (s && typeof s.subtitle_text === "string") {
          lines.push({ kind: "final", text: s.subtitle_text.trim(), t0: Math.round((+s.start_time || 0) * 1000), t1: Math.round((+s.end_time || 0) * 1000), speaker: s.speaker != null ? String(s.speaker) : null, wall: Date.now() });
        }
      }
      if (!lines.length && typeof j.text === "string") lines.push({ kind: "final", text: j.text.trim(), t0: 0, t1: 0, speaker: null, wall: Date.now() });
      return { lines, durMs: Math.round((+j.duration || 0) * 1000) };
    } catch { return { lines: [], durMs: 0 }; }
  }
  if (ext === ".srt" || ext === ".vtt") {
    const blocks = raw.replace(/\r/g, "").split(/\n\n+/);
    for (const b of blocks) {
      const ls = b.split("\n").filter(Boolean);
      const tm = ls.find(l => l.includes("-->"));
      if (!tm) continue;
      const [a, z] = tm.split("-->");
      const text = ls.filter(l => l !== tm && !/^\d+$/.test(l.trim())).join(" ").trim();
      if (text) lines.push({ kind: "final", text, t0: parseSrtTime(a), t1: parseSrtTime(z), speaker: null, wall: Date.now() });
    }
    return { lines, durMs: lines.length ? lines[lines.length - 1].t1 : 0 };
  }
  if (ext === ".html") {
    /* 豆包沙盒产物类 html：只收含大量正文的；剥标签取文本 */
    const text = raw.replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "").replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
    const parts = text.split(/\n+/).map(t => t.trim()).filter(t => t.length >= 2);
    if (parts.join("").length < 200) return { lines: [], durMs: 0 };  /* 太短视为非文稿 */
    for (const t of parts) lines.push({ kind: "final", text: t, t0: 0, t1: 0, speaker: null, wall: Date.now() });
    return { lines, durMs: 0 };
  }
  /* txt / md */
  for (const rawLine of raw.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (/^[#=＝_─-]{3,}$/.test(line)) continue;                       /* 分隔线 */
    if (/^(原始时长|原始片段|平均置信|音频时长|转写|说话人|录音|来源|说明|标题|字数|生成时间|\*\*|#{1,3}\s)/.test(line) && !parseTimestampedLine(line)) continue;  /* 文稿头说明 */
    if (/^\[[^\]]*\]$|^\([^)]*\)$/.test(line) && line.length < 30) continue;  /* 纯括号标注行 */
    const p = parseTimestampedLine(line);
    if (p && p.text) lines.push({ kind: "final", text: p.text, t0: p.t0, t1: p.t1, speaker: null, wall: Date.now() });
    else if (line.length >= 2) lines.push({ kind: "final", text: line, t0: 0, t1: 0, speaker: null, wall: Date.now() });
  }
  return { lines, durMs: lines.length ? lines[lines.length - 1].t1 : 0 };
}

function doubaoImportFile(abs, rel) {
  mkdirSync(STT_DIR, { recursive: true });   /* 首次导入时目录可能不存在（ENOENT 会被上层吞掉导致永远导入 0 条） */
  const st = watchStateRead();
  const stat = fs.statSync(abs);
  const key = rel;
  const prev = st.seen[key];
  if (prev && prev.mtime === stat.mtimeMs && prev.size === stat.size && prev.imported) return null;
  const ext = path.extname(abs).toLowerCase();
  if (!TEXT_EXTS.has(ext)) { st.seen[key] = { mtime: stat.mtimeMs, size: stat.size, imported: false, skip: true }; watchStateWrite(st); return null; }
  let parsed;
  try { parsed = doubaoLinesFromFile({ abs, name: path.basename(abs) }); }
  catch { st.seen[key] = { mtime: stat.mtimeMs, size: stat.size, imported: false, skip: true }; watchStateWrite(st); return null; }
  if (!parsed.lines.length) { st.seen[key] = { mtime: stat.mtimeMs, size: stat.size, imported: false, skip: true }; watchStateWrite(st); return null; }
  const title = guessTitleFromName(path.basename(abs));
  const id = randomUUID();
  const rec = {
    id, source: "browser", sourceLabel: "豆包 APP · 自动导入", title,
    pageUrl: "", startedAt: stat.mtimeMs, endedAt: stat.mtimeMs,
    durationMs: parsed.durMs || (parsed.lines[parsed.lines.length - 1].t1 || 0),
    lines: parsed.lines, status: "done", engine: "doubao-app",
    resourceId: "豆包APP", dir: null, errorMessage: "", hint: "",
    text: parsed.lines.map(l => l.text).join("\n"),
  };
  sttWriteAll([...sttReadAll(), rec]);
  st.seen[key] = { mtime: stat.mtimeMs, size: stat.size, imported: true };
  watchStateWrite(st);
  broadcastStt({ type: "doubao-imported", id, title, lines: parsed.lines.length });
  return rec;
}

/* 递归扫描 chats 目录（日期/会话/文件三层） */
function doubaoScanChats() {
  if (!existsSync(DOUBAO_CHATS_DIR)) return 0;
  let imported = 0;
  const walk = dir => {
    let entries;
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (e.name.startsWith(".")) continue;
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) { walk(abs); continue; }
      if (!TEXT_EXTS.has(path.extname(e.name).toLowerCase())) continue;
      const rel = path.relative(DOUBAO_CHATS_DIR, abs);
      try { if (doubaoImportFile(abs, rel)) imported++; } catch {}
    }
  };
  walk(DOUBAO_CHATS_DIR);
  return imported;
}

let doubaoWatchTimer = null;
function doubaoWatchKick() {
  try {
    const imported = doubaoScanChats();
    if (imported > 0) console.log(`[豆包导入] ${imported} 个新转写文件已入台账`);
  } catch (e) { console.error("[豆包导入] 扫描失败:", e.message); }
  doubaoWatchTimer = setTimeout(doubaoWatchKick, 15000);   /* 15s 轮询，零依赖 */
}


const HTML_FILE = path.join(ROOT, "网课学习工作台.html");
const DEFAULT_DIR = process.env.STUDYDESK_MEDIA || path.join(HOME, "Downloads");
const PAGE_URL = `http://${HOST}:${PORT}/`;

const UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const VIDEO_EXTS = new Set([".mp4", ".mkv", ".mov", ".webm", ".m4v", ".m4a", ".mp3", ".avi", ".flv", ".ts", ".mpg", ".wmv"]);
const DOC_EXTS = new Set([".pdf", ".docx", ".doc"]);
const DOC_MIME = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".doc": "application/msword",
};
const MIME = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".m4a": "audio/mp4", ".mp3": "audio/mpeg",
  ".mov": "video/quicktime",
  ".webm": "video/webm", ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".ts": "video/mp2t", ".flv": "video/x-flv", ".mpg": "video/mpeg", ".wmv": "video/x-ms-wmv",
};

function findFfmpeg() { return toolPath(["ffmpeg"], { envName: "STUDYDESK_FFMPEG" }); }
const fmtSize = n => n >= 1 << 30 ? (n / (1 << 30)).toFixed(2) + " GB"
  : n >= 1 << 20 ? (n / (1 << 20)).toFixed(1) + " MB"
  : n >= 1024 ? (n / 1024).toFixed(0) + " KB" : n + " B";

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(body);
}

/* 同源保护：只允许本机页面调用 API，防其它网页探测本地文件 */
function sameOrigin(req) {
  const host = req.headers.host || "";
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return false;
  const origin = req.headers.origin;
  if (!origin) return true;
  /* 精确匹配：Origin 的 scheme://host:port 必须与 Host 头完全一致
     （不用 startsWith，防 "http://127.0.0.1:PORT/…" 带路径/后缀的构造头放行） */
  return origin === `http://${host}`;
}

/* ── 本机 API 能力令牌 ──
   Referer 可被同源 JS 省略或伪造（fetch referrer 选项 / history.pushState），
   兼容页隔离不能只靠它。工作台自身页面在 HTML 注入点拿到一次性令牌，
   前端统一在 fetch 上附加；被代理页面永远拿不到令牌，因此无法调用本机 API。
   元素加载（<video src> / 壁纸图）无法携带自定义头，对应端点豁免——
   它们只输出媒体字节，JS 无法读取其内容，不构成文件读取通道。 */
const SD_API_TOKEN = crypto.randomBytes(20).toString("hex");
const SHELL_FILE = path.join(HOME, ".study-desk", "shell.token");
function loadShellToken() {
  try {
    const current = fs.readFileSync(SHELL_FILE, "utf8").trim();
    if (/^[0-9a-f]{32,}$/.test(current)) return current;
  } catch {}
  const next = crypto.randomBytes(24).toString("hex");
  fs.mkdirSync(path.dirname(SHELL_FILE), { recursive: true });
  fs.writeFileSync(SHELL_FILE, next + "\n", { mode: 0o600 });
  return next;
}
const SHELL_TOKEN = loadShellToken();
function sendAppPage(res, body, extraHeaders = {}) {
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
    "Set-Cookie": `sd_shell=${SHELL_TOKEN}; Path=/; HttpOnly; SameSite=Lax`,
    ...extraHeaders,
  });
  res.end(body);
}
function sendAppOnly(res) {
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(APP_ONLY_HTML);
}
function sdTokenOk(req, u) {
  if (req.headers["x-sd-token"] === SD_API_TOKEN) return true;
  return u.searchParams.get("sd_token") === SD_API_TOKEN;   /* EventSource 等不能带头的场景 */
}
function localApiAllowed(req, u, p) {
  if (p.startsWith("/api/proxy/")) return true;               /* 代理有自己的授权链路 */
  if (p === "/api/media" || p === "/api/bg/file") return true; /* <video>/<img> 元素加载豁免 */
  if (p === "/api/doubao/events") return true;                 /* SSE 广播，只读非敏感 */
  return sdTokenOk(req, u);
}

async function readBody(req, limit = 65536) {
  let size = 0; const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > limit) { const e = new Error("请求体过大（超出该接口上限）"); e.status = 413; throw e; }
    chunks.push(c);
  }
  return Buffer.concat(chunks).toString("utf8");
}

/* ─────────── 文件夹列表 ─────────── */
function listDir(dir) {
  const entries = readdirSync(dir, { withFileTypes: true })
    .filter(e => !e.name.startsWith("."))
    .map(e => {
      let size = 0, mtime = 0;
      try { const st = statSync(path.join(dir, e.name)); size = st.size; mtime = st.mtimeMs; } catch {}
      return { name: e.name, isDir: e.isDirectory(), isVideo: !e.isDirectory() && VIDEO_EXTS.has(path.extname(e.name).toLowerCase()), size, mtime };
    })
    .filter(e => e.isDir || e.isVideo || DOC_EXTS.has(path.extname(e.name).toLowerCase()))
    .sort((a, b) => (b.isDir - a.isDir) || a.name.localeCompare(b.name, "zh-CN"));
  return { dir, home: HOME, defaultDir: DEFAULT_DIR, parent: path.dirname(dir) !== dir ? path.dirname(dir) : null, entries };
}

/* ─────────── 视频流（Range） ─────────── */
function serveMedia(req, res, file) {
  let st;
  try { st = statSync(file); } catch { return json(res, 404, { error: "文件不存在" }); }
  if (!st.isFile()) return json(res, 400, { error: "不是文件" });
  const type = MIME[path.extname(file).toLowerCase()] || "application/octet-stream";
  const range = req.headers.range;
  const base = { "Content-Type": type, "Accept-Ranges": "bytes", "Cache-Control": "no-store" };
  const pipeSafe = (rs) => { rs.on("error", () => { try { res.destroy(); } catch {} }); rs.pipe(res); };
  if (range) {
    const m = range.match(/bytes=(\d*)-(\d*)/);
    let start = 0, end = st.size - 1;
    if (m && m[1] === "" && m[2] !== "") {
      /* 后缀区间 bytes=-N：返回最后 N 字节 */
      const n = parseInt(m[2]);
      start = Math.max(0, st.size - n); end = st.size - 1;
    } else {
      start = m && m[1] ? parseInt(m[1]) : 0;
      end = m && m[2] ? parseInt(m[2]) : st.size - 1;
      end = Math.min(end, st.size - 1);
    }
    if (isNaN(start) || isNaN(end) || start > end || start >= st.size) {
      res.writeHead(416, { "Content-Range": `bytes */${st.size}` });
      return res.end();
    }
    res.writeHead(206, { ...base, "Content-Range": `bytes ${start}-${end}/${st.size}`, "Content-Length": end - start + 1 });
    pipeSafe(createReadStream(file, { start, end }));
  } else {
    res.writeHead(200, { ...base, "Content-Length": st.size });
    pipeSafe(createReadStream(file));
  }
}

/* ─────────── B站下载（SSE） ─────────── */

/* 匿名设备指纹：先取 buvid3/buvid4 并访问主页激活，可显著降低 412 风控 */
let buvidCache = null;
async function getBuvid() {
  if (buvidCache) return buvidCache;
  try {
    const r = await fetch("https://api.bilibili.com/x/frontend/finger/spi", { headers: { "User-Agent": UA } });
    const j = await r.json();
    const b3 = j?.data?.b_3, b4 = j?.data?.b_4;
    if (!b3) return null;
    await fetch("https://www.bilibili.com/", {
      headers: { "User-Agent": UA, "Referer": "https://www.bilibili.com/", "Cookie": `buvid3=${b3}; buvid4=${b4}` },
    }).catch(() => {});
    buvidCache = `buvid3=${b3}; buvid4=${b4}`;
    return buvidCache;
  } catch { return null; }
}

/* ─────────── B站在线观看（不落盘） ─────────── */

/* B站接口返回的 JSON 偶含裸控制字符，先清洗再 parse */
function biliJson(text) {
  return JSON.parse(text.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, " ").replace(/\r?\n/g, " "));
}
async function biliFetch(url, extraCookie = "") {
  const buvid = await getBuvid();
  const r = await fetch(url, {
    headers: {
      "User-Agent": UA,
      "Referer": "https://www.bilibili.com/",
      "Cookie": [buvid, extraCookie].filter(Boolean).join("; "),
    },
    redirect: "follow",
  });
  return biliJson(await r.text());
}

/* 支持完整链接 / BV号 / av号 / b23.tv 短链；解析出 bvid + 对应分P的 cid */
async function resolveBili(input) {
  let url = input.trim();
  if (/^(BV|av)[0-9A-Za-z]+$/i.test(url)) url = url.startsWith("av") ? `https://www.bilibili.com/video/${url}` : `https://www.bilibili.com/video/${url}`;
  if (!/^https?:\/\//i.test(url)) url = "https://www.bilibili.com/video/" + url;
  if (/b23\.tv/i.test(url)) {
    const r = await fetch(url, { headers: { "User-Agent": UA }, redirect: "follow" });
    url = r.url;
  }
  const bvid = url.match(/BV[0-9A-Za-z]{8,12}/)?.[0];
  const aid = url.match(/av(\d+)/i)?.[1];
  const page = Math.max(1, parseInt(url.match(/[?&]p=(\d+)/)?.[1] || "1"));
  if (!bvid && !aid) throw new Error("链接里没有找到 BV 号 / av 号");
  const q = bvid ? `bvid=${bvid}` : `aid=${aid}`;
  const view = await biliFetch(`https://api.bilibili.com/x/web-interface/view?${q}`);
  if (view.code !== 0) throw new Error(view.message === "啥都木有" ? "视频不存在" : `B站接口错误 ${view.code}: ${view.message}`);
  const d = view.data;
  const pages = (d.pages || []).map(pg => ({ cid: pg.cid, page: pg.page, part: pg.part }));
  const cur = pages.find(pg => pg.page === page) || pages[0] || { cid: d.cid, page: 1, part: d.title };
  return {
    bvid: d.bvid, title: d.title, pagesCount: pages.length || 1,
    cid: cur.cid, page: cur.page, part: cur.part || "", duration: (d.pages || []).find(pg => pg.cid === cur.cid)?.duration || d.duration,
    seek: parseFloat(url.match(/[?&]t=(\d+(?:\.\d+)?)/)?.[1] || "0") || 0,
  };
}

/* html5 单文件 MP4 播放地址（移动网页端通道，支持 Range，无需下载） */
async function getLivePlayUrl(bvid, cid, chromeCookies) {
  let cookie = "";
  if (chromeCookies && existsSync(path.join(os.homedir(), "Library/Application Support/Google/Chrome/Default/Cookies"))) {
    cookie = ""; /* html5 通道匿名即可 720P；会员清晰度请用下载模式 */
  }
  const play = await biliFetch(
    `https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&platform=html5&high_quality=1&qn=64`,
    cookie,
  );
  if (play.code !== 0) throw new Error(`B站接口错误 ${play.code}: ${play.message}`);
  const du = (play.data?.durl || [])[0];
  if (!du?.url) throw new Error("该视频不支持在线直链播放（可能是付费/专属视频），请用「下载后观看」或勾选 Chrome 登录态");
  return { url: du.url, sizeMB: Math.round((du.size || 0) / 1e6), quality: play.data.quality };
}

async function getBiliAudioUrl(info) {
  const play = await biliFetch(`https://api.bilibili.com/x/player/playurl?bvid=${info.bvid}&cid=${info.cid}&fnval=16&qn=64&fourk=0`);
  if (play.code !== 0) throw new Error(`B站音轨接口错误 ${play.code}: ${play.message}`);
  const streams = (play.data?.dash?.audio || []).slice().sort((a, b) => a.bandwidth - b.bandwidth);
  if (!streams.length) throw new Error('该视频没有可访问的独立音轨');
  const candidates = streams.flatMap(a => [a.baseUrl || a.base_url, ...(a.backupUrl || a.backup_url || [])]).filter(Boolean).filter(value => {
    try { const url = new URL(value); return url.protocol === 'https:' && /(^|\.)(bilivideo\.(com|cn|net)|akamaized\.net)$/i.test(url.hostname); }
    catch { return false; }
  });
  // Prefer regular CDN to the platform's P2P mirror on port 8082.
  candidates.sort((a, b) => Number(!!new URL(a).port) - Number(!!new URL(b).port));
  if (!candidates.length) throw new Error('B站返回了无效音轨地址');
  return candidates[0];
}

async function startBiliTranscript(body) {
  if (!/^(?:BV[0-9A-Za-z]+|av\d+|https?:\/\/(?:www\.)?(?:bilibili\.com\/video\/|b23\.tv\/))/i.test(String(body.url || '').trim())) throw new Error('请输入 B站视频链接');
  const info = await resolveBili(String(body.url || ''));
  const durationSec = fullDurationSec(info);
  const sourceKey = `bili:${info.bvid}:${info.cid}:${info.page}`;
  const cacheKey = `${sourceKey}:${durationSec}:fun-asr-nano`;
  const previous = sttReadAll().find(r => r.biliCacheKey === cacheKey && (r.status === 'done' || BILI_TRANSCRIPT_JOBS.has(r.id)));
  if (previous) return { ok: true, id: previous.id, reused: true };
  for (const stale of sttReadAll().filter(r => r.biliCacheKey === cacheKey && r.status === 'recording' && !BILI_TRANSCRIPT_JOBS.has(r.id))) {
    sttUpd(stale.id, { status: 'error', endedAt: Date.now(), errorMessage: '服务曾中断，已启动重试' });
  }
  if (!biliAsrStatus().ready) throw new Error('未找到本地 Fun-ASR-Nano（Qwen3 底座）模型及运行环境');
  const id = randomUUID();
  const dir = path.join(HOME, '.study-desk', 'bili-transcripts', `${info.bvid}-${info.cid}-${durationSec}`);
  const rec = { id, source: 'bili', sourceLabel: 'B站音轨 · 本地 Fun-ASR-Nano（Qwen3 底座）',
    title: `${info.title} · 完整转写`,
    pageUrl: `https://www.bilibili.com/video/${info.bvid}/?p=${info.page}`, sourceKey,
    biliCacheKey: cacheKey, startedAt: Date.now(), endedAt: null, durationMs: durationSec * 1000,
    processedMs: 0, lines: [], status: 'recording', engine: 'fun-asr-nano',
    resourceId: 'Fun-ASR-Nano-2512 / Qwen3-0.6B', dir, phase: '已排队，等待本地识别…', errorMessage: '' };
  sttWriteAll([...sttReadAll(), rec]);
  BILI_TRANSCRIPT_JOBS.set(id, rec);
  const execute = async () => {
    try {
      const mediaUrl = await getBiliAudioUrl(info);
      const result = await transcribeBiliAudio({ dir, mediaUrl, durationSec, onUpdate(event) {
        if (event.type === 'phase') sttUpd(id, { phase: event.phase });
        if (event.type === 'chunk') {
          rec.lines.push(...event.lines);
          sttUpd(id, { lines: rec.lines, processedMs: event.processedSec * 1000,
            phase: `已转写 ${Math.floor(event.processedSec / 60)} / ${Math.ceil(durationSec / 60)} 分钟` });
        }
      } });
      sttUpd(id, { status: 'done', endedAt: Date.now(), lines: result.lines,
        text: result.lines.map(l => l.text).join('\n'), processedMs: durationSec * 1000, phase: '转写完成 · 已保存到本机' });
    } catch (error) {
      sttUpd(id, { status: 'error', endedAt: Date.now(), phase: '转写失败，可重试', errorMessage: error.message });
    } finally { BILI_TRANSCRIPT_JOBS.delete(id); }
  };
  biliTranscriptQueue = biliTranscriptQueue.then(execute, execute);
  return { ok: true, id, reused: false };
}

const LIVE_SECRET = crypto.randomUUID();
const liveSig = u => crypto.createHash("md5").update(LIVE_SECRET + u).digest("hex").slice(0, 16);

/* 反代 CDN MP4，透传 Range → 浏览器同源可拖动、可截图 */
async function biliLiveMedia(req, res, u) {
  let upstream;
  try {
    upstream = await fetch(u, {
      headers: { "User-Agent": UA, "Referer": "https://www.bilibili.com/", ...(req.headers.range ? { Range: req.headers.range } : {}) },
    });
  } catch (e) {
    return json(res, 502, { error: "连接B站CDN失败：" + e.message });
  }
  if (!upstream.ok && upstream.status !== 206) {
    return json(res, upstream.status, { error: "CDN 返回 " + upstream.status });
  }
  const h = {};
  for (const k of ["content-type", "content-length", "content-range", "accept-ranges"]) {
    const v = upstream.headers.get(k);
    if (v) h[k] = k === "content-type" ? "video/mp4" : v;
  }
  if (!h["accept-ranges"]) h["accept-ranges"] = "bytes";
  h["Cache-Control"] = "no-store";
  res.writeHead(upstream.status, h);
  if (req.method === "HEAD") return res.end();
  const { Readable } = await import("node:stream");
  const stream = Readable.fromWeb(upstream.body);
  /* 客户端中断（刷新/关页）时双向销毁，避免未处理错误打崩服务 */
  stream.on("error", () => res.destroy());
  res.on("close", () => stream.destroy());
  req.on("error", () => stream.destroy());
  return stream.pipe(res);
}

async function biliDownload(req, res, body) {
  const url = String(body.url || "").trim();
  const quality = [1080, 720, 480, 360].includes(body.quality) ? body.quality : 1080;
  if (!/^(https?:\/\/)?(www\.)?(bilibili\.com|b23\.tv)\//i.test(url)) {
    return json(res, 400, { error: "请输入 B 站视频链接（bilibili.com/video/… 或 b23.tv/…）" });
  }
  if (!existsSync(YTDLP)) return json(res, 500, { error: "缺少 tools/yt-dlp_macos，请重新解压安装包" });
  const ffmpeg = findFfmpeg();
  if (!ffmpeg) return json(res, 500, { error: "未找到 ffmpeg（合并B站音视频必需）。请执行：brew install ffmpeg" });
  mkdirSync(DOWNLOAD_DIR, { recursive: true });

  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = obj => { if (!res.destroyed && !res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };

  const args = [
    "--no-playlist", "--newline", "--no-mtime",
    "--add-headers", `User-Agent: ${UA}`, "--add-headers", "Referer: https://www.bilibili.com/",
    "--ffmpeg-location", ffmpeg,
    "-P", DOWNLOAD_DIR,
    "-o", "%(title).80s [%(id)s].%(ext)s",
    "--merge-output-format", "mp4",
    "-f", `bv*[vcodec^=avc1][height<=${quality}]+ba[acodec^=mp4a]/bv*[height<=${quality}]+ba/b[height<=${quality}]/b`,
    "--print", "after_move:filepath", "--no-simulate",
  ];
  if (body.chromeCookies) args.push("--cookies-from-browser", "chrome");
  else if (existsSync(COOKIE_FILE)) args.push("--cookies", COOKIE_FILE);
  else {
    const buvid = await getBuvid();
    if (buvid) args.push("--add-headers", `Cookie: ${buvid}`);
  }
  args.push(url);

  const child = spawn(YTDLP, args, { env: toolEnv(), windowsHide: true });
  let filepath = "", errTail = [], closed = false;

  const feed = buf => {
    for (const raw of buf.split("\n")) {
      const line = raw.trim(); if (!line) continue;
      const pct = line.match(/\[download\]\s+([\d.]+)%/);
      if (pct) { send({ type: "progress", pct: parseFloat(pct[1]) }); continue; }
      if (line.startsWith("[Merger]") || line.startsWith("[ExtractAudio]")) { send({ type: "phase", phase: "合并音视频…" }); continue; }
      if (line.startsWith("[download] 100%")) send({ type: "phase", phase: "收尾中…" });
      if (!line.startsWith("[")) { filepath = line; continue; }   /* --print 输出的最终路径 */
      if (/ERROR|error/i.test(line)) { errTail.push(line); send({ type: "log", line: line.slice(0, 300) }); }
    }
  };
  child.stdout.setEncoding("utf8"); child.stdout.on("data", feed);
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", d => { for (const l of d.split("\n")) { const t = l.trim(); if (t) { errTail.push(t); if (errTail.length > 15) errTail.shift(); } } });
  const kill = () => { if (!closed) { closed = true; try { child.kill("SIGKILL"); } catch {} send({ type: "cancelled" }); res.end(); } };
  req.on("close", kill);
  res.on("close", kill);   /* 双保险：客户端断开（刷新/关页）即杀 yt-dlp，不残留下载进程 */
  child.on("error", e => { if (!closed) { closed = true; send({ type: "error", message: String(e) }); res.end(); } });
  child.on("close", code => {
    if (closed) return; closed = true;
    if (code === 0 && filepath && existsSync(filepath)) {
      send({ type: "done", path: filepath, name: path.basename(filepath) });
    } else {
      /* 兜底：找 downloads 里 2 分钟内最新的 mp4 */
      let found = null;
      try {
        const st = statSync(DOWNLOAD_DIR);
        if (st.mtimeMs > Date.now() - 5 * 60 * 1000) {
          const cands = readdirSync(DOWNLOAD_DIR).filter(n => n.endsWith(".mp4"))
            .map(n => { const p = path.join(DOWNLOAD_DIR, n); return { p, t: statSync(p).mtimeMs }; })
            .filter(x => x.t > Date.now() - 2 * 60 * 1000).sort((a, b) => b.t - a.t);
          found = cands[0]?.p;
        }
      } catch {}
      if (code === 0 && found) send({ type: "done", path: found, name: path.basename(found) });
      else {
        const msg = errTail.slice(-4).join(" | ") || `yt-dlp 退出码 ${code}`;
        const friendly = /412/.test(msg)
          ? "B站临时风控(412)：请等几分钟重试；或先在 Chrome 登录 B站，再勾选「使用 Chrome 的 B站登录态」后重新下载"
          : msg;
        send({ type: "error", message: friendly });
      }
    }
    res.end();
  });
}

/* ─────────── 飞书导入（lark-cli） ─────────── */
const FEISHU_DIR = path.join(DOWNLOAD_DIR, "feishu");
const MEDIA_EXTS = new Set([...VIDEO_EXTS]);

function findLarkCli() {
  const found = toolPath(["lark-cli"], { envName: "STUDYDESK_LARK" });
  if (found) return found;
  if (process.env.STUDYDESK_LARK && existsSync(process.env.STUDYDESK_LARK)) return process.env.STUDYDESK_LARK;
  for (const candidate of [
    path.join(HOME, ".local/bin/lark-cli"),
    "/opt/homebrew/bin/lark-cli",
    "/usr/local/bin/lark-cli",
  ]) if (existsSync(candidate)) return candidate;
  return null;
}

function larkEnv() {
  const bin = findLarkCli();
  const extra = [bin ? path.dirname(bin) : "", path.join(HOME, ".local/bin"), "/opt/homebrew/bin", "/usr/local/bin"].filter(Boolean).join(path.delimiter);
  return { ...process.env, HOME, PATH: `${extra}${path.delimiter}${process.env.PATH || ""}` };
}

function parseLarkEnvelope(text) {
  const start = String(text || "").indexOf("{");
  if (start < 0) return null;
  try { return JSON.parse(text.slice(start)); } catch { return null; }
}

function runLark(args, { cwd = ROOT, timeoutMs = 20000, requireOk = true, signal = null } = {}) {
  return new Promise((resolve, reject) => {
    const bin = findLarkCli();
    if (!bin) return reject(new Error("未找到 lark-cli。请先安装飞书 CLI，或在终端执行 lark-cli auth login"));
    const child = spawn(bin, args, { cwd, env: larkEnv() });
    let out = "", err = "";
    const abort = () => { try { child.kill("SIGKILL"); } catch {} };
    if (signal) {
      if (signal.aborted) abort();
      else signal.addEventListener("abort", abort, { once: true });
    }
    const timer = timeoutMs ? setTimeout(() => {
      abort();
      reject(new Error("飞书命令超时，请检查网络或登录状态"));
    }, timeoutMs) : null;
    child.stdout.on("data", d => { out += d; });
    child.stderr.on("data", d => { err += d; });
    child.on("error", e => { if (timer) clearTimeout(timer); reject(e); });
    child.on("close", code => {
      if (timer) clearTimeout(timer);
      if (signal?.aborted) return reject(new Error("下载已取消"));
      const obj = parseLarkEnvelope(out) || parseLarkEnvelope(err);
      if (code === 0 && (!requireOk || obj?.ok)) return resolve(obj);
      const message = obj?.error?.message || obj?.error?.hint || err.trim().slice(-400) || out.trim().slice(-400) || `lark-cli 退出码 ${code}`;
      reject(new Error(message));
    });
  });
}

async function feishuStatus() {
  const cli = findLarkCli();
  if (!cli) return { cli: false, loggedIn: false };
  try {
    /* auth status 成功时返回普通 JSON（无 ok 信封、退出码 0），是否登录以 user 身份 available 为准 */
    const result = await runLark(["auth", "status"], { timeoutMs: 8000, requireOk: false });
    const user = result?.identities?.user;
    const loggedIn = !!(user && user.available);
    return {
      cli: true,
      loggedIn,
      identity: loggedIn ? (result?.identity || "user") : "bot",
      error: loggedIn ? "" : "用户身份未就绪，请在终端执行 lark-cli auth login --domain docs,drive,minutes,wiki",
    };
  } catch (e) {
    return { cli: true, loggedIn: false, error: e.message };
  }
}

function safeFeishuName(name, fallback) {
  const base = String(name || fallback || "feishu").replace(/[\\/:*?"<>|\x00-\x1f]/g, "_").replace(/\s+/g, " ").trim().slice(0, 80);
  return base || fallback || "feishu";
}

function newestFileIn(dir, exts) {
  if (!existsSync(dir)) return null;
  const files = [];
  const walk = current => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (!exts || exts.has(path.extname(entry.name).toLowerCase())) {
        files.push({ path: full, name: entry.name, t: statSync(full).mtimeMs });
      }
    }
  };
  walk(dir);
  files.sort((a, b) => b.t - a.t);
  return files[0] || null;
}

async function feishuTitle(info) {
  if (info.kind === "minutes") {
    const result = await runLark(["minutes", "minutes", "get", "--as", "user", "--params", JSON.stringify({ minute_token: info.token })], { timeoutMs: 15000 });
    return result.data?.minute?.title || result.data?.title || "";
  }
  const result = await runLark(["drive", "+inspect", "--as", "user", "--url", info.url], { timeoutMs: 15000 });
  return result.data?.title || "";
}

async function feishuImport(req, res, body) {
  let info;
  try { info = parseFeishuUrl(body.url || ""); }
  catch (e) { return json(res, 400, { error: e.message }); }
  if (!info.canDownload) return json(res, 400, { error: "此链接没有可下载的录像或文件，请改用「打开网页学习」" });

  mkdirSync(FEISHU_DIR, { recursive: true });
  res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
  const send = obj => { if (!res.writableEnded) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
  let closed = false;
  const finish = obj => { if (closed) return; closed = true; send(obj); res.end(); };
  const abortController = new AbortController();
  req.on("aborted", () => { closed = true; abortController.abort(); });
  res.on("close", () => { if (!res.writableEnded) { closed = true; abortController.abort(); } });

  try {
    send({ type: "phase", phase: "识别飞书链接…" });
    const status = await feishuStatus();
    if (!status.cli) throw new Error("未找到 lark-cli。下载飞书内容需要本机已安装并登录飞书 CLI");
    if (!status.loggedIn) throw new Error("尚未登录飞书。请在终端执行：lark-cli auth login --domain docs,drive,minutes,wiki，然后重试下载");

    send({ type: "phase", phase: "读取标题…" });
    let title = String(body.name || "").trim();
    try { title = title || await feishuTitle(info); } catch {}
    title = safeFeishuName(title, info.label + "-" + (info.token || "file").slice(0, 8));
    send({ type: "log", line: title });

    const outDir = path.join(FEISHU_DIR, `${info.kind}-${info.token || Date.now()}`);
    mkdirSync(outDir, { recursive: true });
    send({ type: "progress", pct: 12 });

    let embeddedVideo = null;
    if (info.kind === "docx" || info.kind === "wiki") {
      send({ type: "phase", phase: "检查文档中嵌入的视频…" });
      try {
        const document = await runLark(["docs", "+fetch", "--as", "user", "--doc", info.url, "--doc-format", "xml"], { timeoutMs: 30000, signal: abortController.signal });
        embeddedVideo = findDocumentVideo(document.data?.document);
      } catch (e) {
        if (/多个视频/.test(e.message)) throw e;
        send({ type: "log", line: "暂未读到文档内视频，将尝试导出文档" });
      }
    }

    if (embeddedVideo) {
      send({ type: "phase", phase: "下载文档中嵌入的视频…" });
      await runLark(["docs", "+media-download", "--as", "user", "--token", embeddedVideo.token, "--output", `./${title}`, "--overwrite"], { cwd: outDir, timeoutMs: 0, signal: abortController.signal });
    } else if (info.action === "minutes") {
      send({ type: "phase", phase: "下载妙记录像，文件较大时请稍候…" });
      await runLark(["minutes", "+download", "--as", "user", "--minute-tokens", info.token, "--output-dir", ".", "--overwrite"], { cwd: outDir, timeoutMs: 0, signal: abortController.signal });
    } else if (info.action === "file") {
      send({ type: "phase", phase: "下载云空间文件…" });
      await runLark(["drive", "+download", "--as", "user", "--url", info.url, "--output", `./${title}`, "--overwrite"], { cwd: outDir, timeoutMs: 0, signal: abortController.signal });
    } else {
      send({ type: "phase", phase: "导出为 PDF…" });
      await runLark(["drive", "+export", "--as", "user", "--url", info.url, "--file-extension", "pdf", "--file-name", `${title}.pdf`, "--output-dir", ".", "--overwrite"], { cwd: outDir, timeoutMs: 120000, signal: abortController.signal });
    }
    if (closed) return;

    /* 妙记会同时导出字幕等附件；优先找录像，避免把最新的文本误当视频打开。 */
    const found = embeddedVideo || info.action === "minutes"
      ? newestFileIn(outDir, MEDIA_EXTS)
      : newestFileIn(outDir, MEDIA_EXTS) || newestFileIn(outDir, DOC_EXTS) || newestFileIn(outDir);
    if (!found) throw new Error(embeddedVideo ? "已找到文档内视频，但下载结果不是工作台支持的视频格式" : "下载完成但没有找到文件，请确认对该链接有查看权限");
    const ext = path.extname(found.name).toLowerCase();
    const kind = DOC_EXTS.has(ext) ? "doc" : MEDIA_EXTS.has(ext) ? "video" : "file";
    send({ type: "progress", pct: 100 });
    finish({ type: "done", path: found.path, name: found.name, kind, title, url: info.url, feishuKind: info.kind });
  } catch (e) {
    finish({ type: "error", message: e.message || String(e) });
  }
}

/* ─────────── MCP 服务连接（配置存 ~/.study-desk，不进安装包） ─────────── */
const MCP_CONFIG_FILE = path.join(HOME, ".study-desk", "mcp-servers.json");
const mcpClients = new Map();   /* name → { client, status, tools, error } */

function mcpReadConfig() {
  try {
    const cfg = JSON.parse(readFileSync(MCP_CONFIG_FILE, "utf8"));
    return Array.isArray(cfg.servers) ? cfg : { servers: [] };
  } catch { return { servers: [] }; }
}
function mcpWriteConfig(cfg) {
  mkdirSync(path.dirname(MCP_CONFIG_FILE), { recursive: true });
  writeFileSync(MCP_CONFIG_FILE, JSON.stringify(cfg, null, 2));
}
function mcpEntry(name) {
  if (!mcpClients.has(name)) mcpClients.set(name, { client: null, status: "disconnected", tools: [], error: null });
  return mcpClients.get(name);
}
/* 服务常从 Finder/launchd 启动，PATH 很短：spawn MCP 命令前补上常用工具目录 */
const MCP_PATH_EXTRA = [
  path.dirname(process.execPath),
  "/opt/homebrew/bin", "/opt/homebrew/sbin",
  "/usr/local/bin", path.join(HOME, ".local/bin"),
];
function mcpSpawnEnv() {
  const cur = process.env.PATH || "";
  const add = MCP_PATH_EXTRA.filter(p => p && !cur.split(path.delimiter).includes(p));
  return { ...process.env, PATH: [...(cur ? [cur] : []), ...add].join(path.delimiter) };
}
async function mcpConnect(name) {
  const cfg = mcpReadConfig().servers.find(s => s.name === name);
  if (!cfg) return { ok: false, error: "配置不存在" };
  const entry = mcpEntry(name);
  let transport = null;
  try {
    entry.client?.close?.();
    entry.client = null;
    transport = cfg.transport.type === "http"
      ? new McpHttpTransport({ url: cfg.transport.url })
      : new McpStdioTransport({ command: cfg.transport.command, args: cfg.transport.args || [], env: mcpSpawnEnv() });
    const client = new McpClient(transport);
    /* stdio 进程意外退出 → 即时把该服务标记为 error，避免列表仍显示已连接 */
    const prevOnClose = transport.onClose;
    transport.onClose = err => {
      try { prevOnClose?.(err); } catch {}
      if (mcpClients.get(name) === entry && entry.client === client) {
        entry.status = "error";
        entry.error = "服务进程已退出";
        entry.tools = [];
      }
    };
    entry.client = client;
    entry.status = "connecting";
    entry.error = null;
    await transport.start();
    await client.initialize();
    const tools = await client.listTools();
    entry.status = "connected";
    entry.tools = (tools?.tools || []).map(t => ({
      name: t.name, description: t.description || "", inputSchema: t.inputSchema || {},
    }));
    return { ok: true, tools: entry.tools };
  } catch (e) {
    entry.status = "error";
    const tail = transport?.stderrTail?.split("\n").filter(Boolean).slice(-1)[0] || "";
    entry.error = [String(e.message || e), tail].filter(Boolean).join(" · ").slice(0, 300);
    entry.tools = [];
    try { entry.client?.close?.(); } catch {}
    entry.client = null;
    return { ok: false, error: entry.error };
  }
}
function mcpDisconnect(name) {
  const entry = mcpClients.get(name);
  if (!entry) return;
  try { entry.client?.close?.(); } catch {}
  entry.client = null;
  entry.status = "disconnected";
  entry.tools = [];
  entry.error = null;
}

/* ═══════════════ 笔记数据库（node:sqlite，所有查询参数绑定） ═══════════════ */
const NOTES_DB_FILE = path.join(HOME, ".study-desk", "notes.db");
const NOTES_REV_KEEP = 20;   /* 每篇笔记保留最近 20 个历史版本 */
let notesDb = null;
let notesDbError = "";

function notesOpen() {
  if (notesDb) return notesDb;
  if (notesDbError) return null;
  if (!DatabaseSync) { notesDbError = "当前 Node 缺少内置 SQLite（需 22.5+），笔记仍保存在本机页面里"; return null; }
  try {
    mkdirSync(path.dirname(NOTES_DB_FILE), { recursive: true });
    notesDb = new DatabaseSync(NOTES_DB_FILE);
    notesDb.exec("PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 3000;");
    notesDb.exec(`
      CREATE TABLE IF NOT EXISTS notes (
        context_key TEXT PRIMARY KEY,
        name        TEXT NOT NULL DEFAULT '',
        kind        TEXT NOT NULL DEFAULT 'note',
        source      TEXT NOT NULL DEFAULT '',
        course_id   TEXT NOT NULL DEFAULT '',
        course_name TEXT NOT NULL DEFAULT '',
        tags        TEXT NOT NULL DEFAULT '[]',
        status      TEXT NOT NULL DEFAULT 'new',
        html        TEXT NOT NULL DEFAULT '',
        text_plain  TEXT NOT NULL DEFAULT '',
        word_count  INTEGER NOT NULL DEFAULT 0,
        saved_at    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT 0,
        updated_at  INTEGER NOT NULL DEFAULT 0,
        revision    INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_notes_updated ON notes(updated_at DESC);
      CREATE TABLE IF NOT EXISTS note_revisions (
        id          INTEGER PRIMARY KEY AUTOINCREMENT,
        context_key TEXT NOT NULL,
        html        TEXT NOT NULL,
        text_plain  TEXT NOT NULL DEFAULT '',
        saved_at    INTEGER NOT NULL DEFAULT 0,
        created_at  INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_rev_key ON note_revisions(context_key, saved_at DESC);
    `);
    return notesDb;
  } catch (e) {
    notesDbError = "笔记库打开失败：" + (e?.message || e);
    notesDb = null;
    return null;
  }
}

function stripHtmlToText(html) {
  return String(html || "")
    .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, " ")
    .replace(/<br\s*\/?>|<\/(p|div|h[1-6]|li|blockquote|tr|figcaption)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;|&amp;|&lt;|&gt;|&quot;|&#39;/g, m => ({ "&nbsp;": " ", "&amp;": "&", "&lt;": "<", "&gt;": ">", "&quot;": '"', "&#39;": "'" })[m])
    .replace(/[ \t\u00a0]+/g, " ")
    .replace(/\n\s*\n+/g, "\n")
    .trim();
}

const escapeLike = q => String(q).replace(/[\\%_]/g, ch => "\\" + ch);

function noteRowOf(r, withHtml = false) {
  const row = {
    key: r.context_key, name: r.name, kind: r.kind, source: r.source,
    courseId: r.course_id, courseName: r.course_name,
    tags: (() => { try { return JSON.parse(r.tags || "[]"); } catch { return []; } })(),
    status: r.status, text: r.text_plain, wordCount: r.word_count,
    savedAt: r.saved_at, createdAt: r.created_at, updatedAt: r.updated_at, revision: r.revision,
  };
  if (withHtml) row.html = r.html;
  return row;
}

/* 命中词附近约 span 字，纯文本，不加标记 */
function snippetNear(text, word, span = 80) {
  const src = String(text || "").replace(/\s+/g, " ").trim();
  if (!src) return "";
  const w = String(word || "");
  const i = w ? src.toLowerCase().indexOf(w.toLowerCase()) : -1;
  if (i < 0) return src.slice(0, span);
  const pad = Math.max(0, Math.floor((span - Math.min(w.length, span)) / 2));
  const start = Math.max(0, i - pad);
  return src.slice(start, start + span);
}

function searchNotes(words) {
  const db = notesOpen();
  if (!db) return { notes: [], notesError: notesDbError || "笔记库不可用" };
  try {
    const cols = "context_key, name, kind, source, course_id, course_name, tags, status, text_plain, word_count, saved_at, created_at, updated_at, revision";
    const clauses = [];
    const params = [];
    for (const w of words) {
      const pat = `%${escapeLike(w)}%`;
      clauses.push("(name LIKE ? ESCAPE '\\' OR text_plain LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR course_name LIKE ? ESCAPE '\\')");
      params.push(pat, pat, pat, pat);
    }
    params.push(20);
    const rows = db.prepare(`SELECT ${cols} FROM notes WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC LIMIT ?`).all(...params);
    return {
      notes: rows.map(r => {
        const n = noteRowOf(r);
        return {
          key: n.key,
          name: n.name || "",
          courseName: n.courseName || "",
          snippet: snippetNear(n.text, words[0], 80),
          savedAt: n.savedAt,
        };
      }),
    };
  } catch {
    return { notes: [], notesError: "笔记搜索失败" };
  }
}

function searchTranscripts(words) {
  const lowWords = words.map(w => String(w).toLowerCase());
  const hits = [];
  const list = sttReadAll().slice().sort((a, b) => (Number(b?.startedAt) || 0) - (Number(a?.startedAt) || 0));
  for (const r of list) {
    if (!r || typeof r !== "object") continue;
    const lines = Array.isArray(r.lines) ? r.lines : [];
    const hay = [r.title, r.text, r.sourceLabel, ...lines.map(l => l && l.text)].join("\n").toLowerCase();
    if (!lowWords.every(w => hay.includes(w))) continue;
    let best = null, bestScore = 0;
    for (const l of lines) {
      if (!l || typeof l.text !== "string") continue;
      const low = l.text.toLowerCase();
      let score = 0;
      for (const w of lowWords) if (low.includes(w)) score++;
      if (score > bestScore) { best = l; bestScore = score; }
    }
    let snippet, t = null;
    if (best) {
      const focus = lowWords.find(w => best.text.toLowerCase().includes(w)) || lowWords[0];
      snippet = snippetNear(best.text, focus, 80);
      const t0 = Number(best.t0);
      t = Number.isFinite(t0) ? t0 / 1000 : null;
    } else {
      snippet = snippetNear(r.text || "", lowWords[0], 80);
    }
    hits.push({
      id: r.id,
      title: r.title || "",
      courseName: r.courseName || "",
      snippet,
      t,
    });
    if (hits.length >= 20) break;
  }
  return hits;
}

function vaultPlain(v) {
  if (typeof v !== "string" || !v) return "";
  return stripHtmlToText(v);
}

function vaultSearchHit(it) {
  const src = it && typeof it === "object" ? it : {};
  return {
    id: src.id == null ? "" : String(src.id),
    title: src.title == null ? "" : String(src.title),
    kind: src.kind == null ? "" : String(src.kind),
    category: src.category == null ? "" : String(src.category),
    snippet: (vaultPlain(src.summary) || vaultPlain(src.notes)).slice(0, 80),
  };
}

async function searchVault(q) {
  try {
    const r = await vaultFetch(`/search?q=${encodeURIComponent(q)}&limit=20`, { timeoutMs: 1500 });
    let data = null;
    try { data = await r.json(); } catch { data = null; }
    if (!r.ok || !data || typeof data !== "object") return { vault: [], vaultError: "学习资产库搜索失败" };
    const items = Array.isArray(data.items) ? data.items : [];
    return { vault: items.slice(0, 20).map(vaultSearchHit) };
  } catch (e) {
    const vaultError = e?.name === "TimeoutError"
      ? "学习资产库连接超时（应用可能在启动中）"
      : `无法连接学习资产库（${VAULT_PORT}）——请确认「学习资产库」应用正在运行`;
    return { vault: [], vaultError };
  }
}

/* 空查询不打资产库。笔记库或资产库失败只带各自的 error 字段，整请求仍 200。 */
async function deskSearch(qRaw) {
  const q = String(qRaw || "").trim();
  const out = { ok: true, notes: [], transcripts: [], vault: [] };
  if (!q) return out;
  const words = q.split(/\s+/).filter(Boolean);
  const vaultP = searchVault(q);
  const noteRes = searchNotes(words);
  out.notes = noteRes.notes;
  if (noteRes.notesError) out.notesError = String(noteRes.notesError);
  try { out.transcripts = searchTranscripts(words); }
  catch { out.transcripts = []; }
  const vaultRes = await vaultP;
  out.vault = vaultRes.vault || [];
  if (vaultRes.vaultError) out.vaultError = String(vaultRes.vaultError);
  return out;
}

/* 乱序保护：savedAt 不小于库中版本才落盘；新版本追加修订并裁剪到 REV_KEEP */
function notesSaveRecord(rec, { touchRevision = true } = {}) {
  const db = notesOpen();
  if (!db) throw new Error(notesDbError || "笔记库不可用");
  const now = Date.now();
  const text = stripHtmlToText(rec.html);
  const prev = db.prepare("SELECT saved_at, revision FROM notes WHERE context_key = ?").get(rec.key);
  let changed = false;
  if (!prev) {
    db.prepare(`INSERT INTO notes
      (context_key, name, kind, source, course_id, course_name, tags, status, html, text_plain, word_count, saved_at, created_at, updated_at, revision)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1)`)
      .run(rec.key, rec.name, rec.kind, rec.source, rec.courseId, rec.courseName, rec.tagsJson, rec.status,
           rec.html, text, text.length, rec.savedAt, now, now);
    changed = true;
  } else if (Number(rec.savedAt) >= Number(prev.saved_at)) {
    db.prepare(`UPDATE notes SET name = ?, kind = ?, source = ?, course_id = ?, course_name = ?, tags = ?, status = ?,
      html = ?, text_plain = ?, word_count = ?, saved_at = ?, updated_at = ?, revision = revision + 1
      WHERE context_key = ?`)
      .run(rec.name, rec.kind, rec.source, rec.courseId, rec.courseName, rec.tagsJson, rec.status,
           rec.html, text, text.length, rec.savedAt, now, rec.key);
    changed = true;
  }
  if (changed && touchRevision && rec.html) {
    db.prepare("INSERT INTO note_revisions (context_key, html, text_plain, saved_at, created_at) VALUES (?, ?, ?, ?, ?)")
      .run(rec.key, rec.html, text, rec.savedAt, now);
    db.prepare(`DELETE FROM note_revisions WHERE context_key = ? AND id NOT IN
      (SELECT id FROM note_revisions WHERE context_key = ? ORDER BY id DESC LIMIT ?)`)
      .run(rec.key, rec.key, NOTES_REV_KEEP);
  }
  return { changed, revision: changed ? (prev ? prev.revision + 1 : 1) : (prev?.revision || 0) };
}

/* ═══════════════ 网页兼容模式（本地反向代理：小鹅通 / 腾讯会议回放等） ═══════════════ */
const PROXY_HOSTS_FILE = path.join(HOME, ".study-desk", "proxy-hosts.json");
const PROXY_COOKIE_FILE = path.join(HOME, ".study-desk", "proxy-cookies.json");
const proxyCookieJar = new CookieJar(PROXY_COOKIE_FILE);

function loadJsonFile(f, fallback) {
  try { const v = JSON.parse(readFileSync(f, "utf8")); return v && typeof v === "object" ? v : fallback; }
  catch { return fallback; }
}
const PROXY_STATE = loadJsonFile(PROXY_HOSTS_FILE, { allowed: [], learned: [] });
if (!Array.isArray(PROXY_STATE.allowed)) PROXY_STATE.allowed = [];
if (!Array.isArray(PROXY_STATE.learned)) PROXY_STATE.learned = [];
function proxyPersistHosts() {
  try {
    mkdirSync(path.dirname(PROXY_HOSTS_FILE), { recursive: true });
    const tmp = PROXY_HOSTS_FILE + ".tmp";
    writeFileSync(tmp, JSON.stringify(PROXY_STATE, null, 1));
    fs.renameSync(tmp, PROXY_HOSTS_FILE);
    try { fs.chmodSync(PROXY_HOSTS_FILE, 0o600); } catch {}
  } catch {}
}
function proxyAllHosts() {
  return [...new Set([...PROXY_STATE.allowed, ...PROXY_STATE.learned].map(h => String(h).toLowerCase()))];
}
function proxyHostAllowed(host) {
  const h = String(host || "").toLowerCase();
  return isXiaoeHost(h) || PROXY_STATE.allowed.includes(h) || PROXY_STATE.learned.includes(h);
}
/* 学习主机：仅在用户自己导航产生的重定向链上出现，且必须解析为公网 */
function proxyLearnHost(host) {
  const h = String(host || "").toLowerCase();
  if (!h || isPrivateHost(h) || h.includes(":")) return false;
  if (proxyHostAllowed(h)) return false;
  PROXY_STATE.learned.push(h);
  if (PROXY_STATE.learned.length > 200) PROXY_STATE.learned = PROXY_STATE.learned.slice(-200);
  proxyPersistHosts();
  return true;
}
function normalizeProxyHost(v) {
  let s = String(v || "").trim().toLowerCase();
  if (!s) return "";
  if (!/^[a-z][a-z0-9+.-]*:\/\//.test(s)) s = "https://" + s;
  try {
    const u = new URL(s);
    const allowLoop = process.env.STUDYDESK_PROXY_ALLOW_LOOPBACK === "1";   /* 仅测试隔离环境 */
    if ((isPrivateHost(u.hostname) && !allowLoop) || u.hostname.includes(":")) return "";
    return u.hostname;
  } catch { return ""; }
}

const proxyDnsCache = new Map();
async function proxyHostResolvesPublic(host) {
  if (process.env.STUDYDESK_PROXY_ALLOW_LOOPBACK === "1") return true;   /* 仅测试隔离环境使用 */
  if (isPrivateHost(host)) return false;
  const hit = proxyDnsCache.get(host);
  if (hit && Date.now() - hit.at < 300000) return hit.ok;
  let ok = false;
  try {
    const addrs = await dns.promises.lookup(host, { all: true });
    ok = addrs.length > 0 && addrs.every(a => !isPrivateHost(a.address));
  } catch { ok = false; }
  proxyDnsCache.set(host, { ok, at: Date.now() });
  return ok;
}

async function readBodyBuffer(req, limit = 10 * 1024 * 1024) {
  let size = 0; const chunks = [];
  for await (const c of req) { size += c.length; if (size > limit) throw new Error("请求体过大"); chunks.push(c); }
  return Buffer.concat(chunks);
}

function proxyUpstreamHeaders(req, targetUrl) {
  const t = new URL(targetUrl);
  const fwd = {};
  for (const h of ["accept", "accept-language", "user-agent", "range", "content-type", "x-requested-with", "accept-encoding"]) {
    const v = req.headers[h];
    if (v) fwd[h] = Array.isArray(v) ? v.join(", ") : String(v);
  }
  const cookie = proxyCookieJar.header(t.hostname);
  if (cookie) fwd.cookie = cookie;
  /* Referer / Origin 映射回上游域：避免泄露本机地址，也绕开热链拦截 */
  let refUp = `${t.protocol}//${t.host}/`;
  const ref = req.headers.referer;
  if (ref) {
    try {
      const ru = new URL(ref);
      if (ru.pathname.startsWith(PROXY_API_PREFIX + "/")) {
        const pr = parseProxyPath(ru.pathname);
        if (pr) refUp = upstreamUrl(pr, ru.search);
      } else if (ru.host === req.headers.host) {
        refUp = `${t.protocol}//${t.host}${ru.pathname}`;
      }
    } catch {}
  }
  fwd.referer = refUp;
  fwd.origin = `${t.protocol}//${t.host}`;
  return fwd;
}

const PROXY_STRIP_HEADERS = new Set([
  "connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer",
  "transfer-encoding", "upgrade", "set-cookie",
  /* 内嵌可行性的关键：去掉让 iframe 拒绝渲染与限制脚本的响应头 */
  "content-security-policy", "content-security-policy-report-only", "x-frame-options",
  "cross-origin-opener-policy", "cross-origin-embedder-policy", "cross-origin-resource-policy",
  "permissions-policy", "strict-transport-security", "report-to", "nel", "clear-site-data",
  "content-encoding", "content-length",
]);
function filterProxyHeaders(h) {
  const out = {};
  for (const [k, v] of h.entries()) {
    if (PROXY_STRIP_HEADERS.has(k.toLowerCase())) continue;
    out[k] = v;
  }
  return out;
}

const PROXY_TEST_FLAGS = {
  allowLoopback: process.env.STUDYDESK_PROXY_ALLOW_LOOPBACK === "1",      /* 仅测试隔离环境 */
  allowNonStandardPort: process.env.STUDYDESK_PROXY_ANY_PORT === "1",
};
function proxyRewriteCtx(urlObj, extraHosts) {
  return { scheme: urlObj.protocol.slice(0, -1), host: urlObj.hostname, port: urlObj.port, extraHosts, ...PROXY_TEST_FLAGS };
}

async function proxyRespond(req, res, resp, finalUrl, extraHosts) {
  const t = new URL(finalUrl);
  const ct = (resp.headers.get("content-type") || "").toLowerCase();
  const isHtml = ct.includes("text/html");
  const isCss = ct.includes("text/css");
  const isJs = /javascript|ecmascript/.test(ct);
  const isJson = ct.includes("json");
  const isM3u8 = ct.includes("mpegurl");
  const isVtt = ct.includes("text/vtt");
  const isXml = ct.includes("xml");
  const texty = isHtml || isCss || isJs || isJson || isM3u8 || isVtt || isXml;

  const headers = filterProxyHeaders(resp.headers);
  headers["x-sd-proxy"] = "1";
  if (!headers["cache-control"]) headers["cache-control"] = "no-store";

  if (!texty) {
    /* 二进制流（mp4 / ts / 图片）：管道转发；未压缩时保留 content-length，保证拖动与 Range 正常 */
    if (!resp.headers.get("content-encoding") && resp.headers.get("content-length")) {
      headers["content-length"] = resp.headers.get("content-length");
    }
    res.writeHead(resp.status, headers);
    if (req.method === "HEAD" || !resp.body) { res.end(); return; }
    const { Readable } = await import("node:stream");
    const quietCancel = () => { try { Promise.resolve(resp.body.cancel()).catch(() => {}); } catch {} };
    const stream = Readable.fromWeb(resp.body);
    /* 闲置超时：上游发完响应头后 body 停滞 60 秒即回收连接（持续输出的媒体流不受影响） */
    let idleTimer = null;
    const armIdle = () => {
      clearTimeout(idleTimer);
      idleTimer = setTimeout(() => { try { stream.destroy(); } catch {} try { res.destroy(); } catch {} quietCancel(); }, 60000);
      idleTimer.unref?.();
    };
    stream.on("data", armIdle);
    stream.on("error", () => { clearTimeout(idleTimer); quietCancel(); res.destroy(); });
    res.on("close", () => { clearTimeout(idleTimer); quietCancel(); });
    armIdle();
    stream.pipe(res);
    return;
  }

  const buf = Buffer.from(await resp.arrayBuffer());
  let charset = (ct.match(/charset=([\w-]+)/i) || [])[1] || "";
  if (isHtml && !charset) {
    const head = buf.subarray(0, 2048).toString("latin1");
    charset = (head.match(/<meta[^>]+charset\s*=\s*["']?([\w-]+)/i) || [])[1] || "";
  }
  let text;
  if (charset && !/utf-?8/i.test(charset)) {
    try { text = new TextDecoder(charset.toLowerCase()).decode(buf); }
    catch { text = buf.toString("utf8"); }
  } else {
    text = buf.toString("utf8");
  }

  const ctx = proxyRewriteCtx(t, extraHosts);
  if (isHtml) {
    const bridge = bridgeScript({
      apiPrefix: PROXY_API_PREFIX,
      prefix: `${PROXY_API_PREFIX}/${ctx.scheme}/${t.host}`,
      host: t.hostname,
      pageUrl: finalUrl,
      extra: ctx.extraHosts,
    });
    text = rewriteHtml(text, { ...ctx, bridge });
  }
  else if (isCss) text = rewriteCss(text, ctx);
  else if (isM3u8) text = rewriteM3u8(text, ctx, finalUrl);
  else if (isVtt) text = rewriteVtt(text, ctx, finalUrl);
  else if (isJson || isJs || isXml) text = rewriteJs(text, ctx);

  let outCt = resp.headers.get("content-type") || (isHtml ? "text/html" : "text/plain");
  outCt = /charset=/i.test(outCt) ? outCt.replace(/charset=[\w-]+/i, "charset=utf-8") : `${outCt}; charset=utf-8`;
  headers["content-type"] = outCt;
  if (isHtml) headers["cache-control"] = "no-store";
  headers["content-length"] = String(Buffer.byteLength(text));
  res.writeHead(resp.status, headers);
  res.end(req.method === "HEAD" ? undefined : text);
}

async function proxyHandle(req, res, u) {
  const parsed = parseProxyPath(u.pathname, { allowNonStandardPort: process.env.STUDYDESK_PROXY_ANY_PORT === "1" });
  if (!parsed) return json(res, 404, { error: "代理路径无效" });
  if (parsed.scheme !== "https" && parsed.scheme !== "http") return json(res, 404, { error: "仅支持 http/https 上游" });
  if (!proxyHostAllowed(parsed.host)) return json(res, 403, { error: "该域名未允许兼容代理（从工作台打开链接时会自动授权）" });
  if (!await proxyHostResolvesPublic(parsed.host)) return json(res, 403, { error: "该域名解析到内网地址，已拒绝代理" });

  let target = upstreamUrl(parsed, u.search);
  let sendMethod = req.method;
  let sendBody = null;
  if (!["GET", "HEAD"].includes(req.method)) {
    try { sendBody = await readBodyBuffer(req); } catch (e) { return json(res, 413, { error: e.message }); }
  }
  const extra = proxyAllHosts();

  try {
    for (let hop = 0; hop < 8; hop++) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(new Error("上游响应超时")), 30000);
      let resp;
      try {
        resp = await fetch(target, {
          method: sendMethod,
          headers: proxyUpstreamHeaders(req, target),
          body: ["GET", "HEAD"].includes(sendMethod) ? undefined : sendBody,
          redirect: "manual",
          signal: ac.signal,
        });
      } finally { clearTimeout(timer); }

      const setCookies = resp.headers.getSetCookie ? resp.headers.getSetCookie() : [];
      if (setCookies.length) proxyCookieJar.store(setCookies, new URL(target).hostname);

      const loc = resp.headers.get("location");
      if ([301, 302, 303, 307, 308].includes(resp.status) && loc) {
        const next = new URL(loc, target);
        if (next.protocol !== "http:" && next.protocol !== "https:") { resp.body?.cancel?.(); return json(res, 502, { error: "不支持的重定向目标：" + next.protocol }); }
        /* 每一跳与初始请求同规则：仅 80/443（测试开关除外），防 302 绕开端口限制 */
        if (next.port && next.port !== "80" && next.port !== "443" && process.env.STUDYDESK_PROXY_ANY_PORT !== "1") {
          resp.body?.cancel?.(); return json(res, 502, { error: "重定向到非标准端口已拒绝：" + next.port });
        }
        if (next.hostname !== new URL(target).hostname) proxyLearnHost(next.hostname);
        if (proxyHostAllowed(next.hostname) && await proxyHostResolvesPublic(next.hostname)) {
          try { resp.body?.cancel?.(); } catch {}
          target = next.href;
          if ([301, 302, 303].includes(resp.status)) { sendMethod = "GET"; sendBody = null; }
          continue;
        }
        /* 无法继续跟随：改写 Location 交给浏览器 */
        const t0 = new URL(target);
        const headers0 = filterProxyHeaders(resp.headers);
        headers0.location = rewriteLocation(loc, { scheme: t0.protocol.slice(0, -1), host: t0.host, extraHosts: extra, ...PROXY_TEST_FLAGS });
        try { resp.body?.cancel?.(); } catch {}
        res.writeHead(resp.status, headers0);
        res.end();
        return;
      }
      return await proxyRespond(req, res, resp, target, extra);
    }
    return json(res, 502, { error: "上游重定向次数过多" });
  } catch (e) {
    if (res.headersSent) { try { res.destroy(); } catch {} return; }
    const why = e?.cause?.message || e?.cause?.code || e?.message || e;
    return json(res, 502, { error: "兼容代理请求失败：" + why });
  }
}

/* ─────────── 路由 ─────────── */
const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, PAGE_URL);
  for (const key of ['path', 'dir']) if (u.searchParams.has(key)) u.searchParams.set(key, resolveStoredPath(u.searchParams.get(key)));
  const p = u.pathname;
  try {
    if (p === "/_studydesk/health") {
      if (req.headers["x-studydesk-shell"] !== SHELL_TOKEN || !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      return json(res, 200, { app: "study-desk", pid: process.pid, root: fs.realpathSync(ROOT), home: path.resolve(HOME) });
    }
    if (p.startsWith("/api/") && !sameOrigin(req)) return json(res, 403, { error: "forbidden" });
    /* 本机 API 能力令牌：无令牌的 /api/* 一律拒绝（代理 / 元素媒体端点豁免） */
    if (p.startsWith("/api/") && !localApiAllowed(req, u, p)) return json(res, 403, { error: "forbidden" });
    /* 兼容模式隔离：被代理页面发起的请求只允许走代理通道，不得触碰本机文件 / 笔记 / MCP 等本机 API。
       非本地路由的路径（SPA 的动态 import / Worker / EventSource 等根相对逃逸）按 Referer 的上游主机透明代理。 */
    let fromProxyPage = false;
    try { fromProxyPage = new URL(req.headers.referer || "about:blank").pathname.startsWith(PROXY_API_PREFIX + "/"); } catch {}
    if (fromProxyPage && !p.startsWith(PROXY_API_PREFIX + "/") && !p.startsWith("/vendor/")) {
      const isLocalRoute = p === "/" || p === "/index.html" || p.startsWith("/api/")
        || p === "/" + encodeURIComponent("转写配置指南") + ".html" || decodeURI(p) === "/转写配置指南.html";
      if (isLocalRoute) return json(res, 403, { error: "forbidden" });
      const ref = parseProxyPath(new URL(req.headers.referer).pathname, { allowNonStandardPort: process.env.STUDYDESK_PROXY_ANY_PORT === "1" });
      if (!ref) return json(res, 403, { error: "forbidden" });
      const portPart = ref.port && ref.port !== 80 && ref.port !== 443 ? `:${ref.port}` : "";
      const proxied = new URL(`${PROXY_API_PREFIX}/${ref.scheme}/${ref.host}${portPart}/${p.replace(/^\/+/, "")}${u.search}`, PAGE_URL);
      return await proxyHandle(req, res, proxied);
    }
    if (req.method === "GET" && (p === "/" || p === "/index.html")) {
      /* 浏览器直接打开地址时不提供工作台页面。本地应用携带 shell 凭证。 */
      if (!appDocumentAllowed(req.headers, SHELL_TOKEN)) return sendAppOnly(res);
      /* 注入本机 API 能力令牌：仅工作台自身页面持有，被代理页面拿不到，
         防止其用 no-referrer / pushState 伪造 Referer 绕过隔离调用本机 API。 */
      const html = readFileSync(HTML_FILE, "utf8").replace("__SD_API_TOKEN__", SD_API_TOKEN);
      return sendAppPage(res, html);
    }
    if (req.method === "GET" && (p === "/转写配置指南.html" || p === "/" + encodeURIComponent("转写配置指南") + ".html" || decodeURI(p) === "/转写配置指南.html")) {
      if (!appDocumentAllowed(req.headers, SHELL_TOKEN)) return sendAppOnly(res);
      const f = path.join(ROOT, "转写配置指南.html");
      if (!existsSync(f)) return json(res, 404, { error: "guide not found" });
      return sendAppPage(res, readFileSync(f));
    }
    /* ═══════ 本机实时语音识别 ═══════ */
    if (req.method === "GET" && p === "/api/local-asr/status") {
      return json(res, 200, {
        ok: true, runtimeReady: localAsrRuntimeReady(), modelReady: localAsrModelReady(LOCAL_ASR_DIR),
        model: LOCAL_ASR_MODEL, downloading: localAsrDownloading,
      });
    }
    if (req.method === "GET" && p === "/api/local-asr/model") {
      if (localAsrDownloading) return json(res, 409, { error: "模型正在下载" });
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const send = obj => { if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      if (localAsrModelReady(LOCAL_ASR_DIR)) { send({ type: "done" }); res.end(); return; }
      localAsrDownloading = true;
      let cancelled = false;
      res.on("close", () => { cancelled = true; });
      try {
        mkdirSync(LOCAL_ASR_DIR, { recursive: true });
        const { createHash } = await import("node:crypto");
        for (const [name, meta] of Object.entries(LOCAL_ASR_FILES)) {
          const dest = path.join(LOCAL_ASR_DIR, name);
          if (existsSync(dest) && statSync(dest).size >= meta.min) continue;
          const url = `https://hf-mirror.com/${LOCAL_ASR_MODEL}/resolve/${LOCAL_ASR_REVISION}/${name}`;
          send({ type: "phase", phase: `下载 ${name}…` });
          const upstream = await fetch(url, { signal: AbortSignal.timeout(180000) });
          if (!upstream.ok || !upstream.body) throw new Error(`模型下载失败：${name}（HTTP ${upstream.status}）`);
          const part = dest + ".part";
          const out = await fs.promises.open(part, "w");
          const hash = createHash("sha256");
          let got = 0, lastPct = -5;
          try {
            for await (const chunk of upstream.body) {
              if (cancelled) throw new Error("下载已取消");
              let offset = 0;
              while (offset < chunk.length) {
                const { bytesWritten } = await out.write(chunk, offset, chunk.length - offset);
                if (!bytesWritten) throw new Error(`模型文件写入失败：${name}`);
                offset += bytesWritten;
              }
              hash.update(chunk); got += chunk.length;
              const pct = Math.min(100, Math.floor(got / meta.min * 100));
              if (pct >= lastPct + 5) { lastPct = pct; send({ type: "progress", file: name, pct }); }
            }
          } finally { await out.close(); }
          if (got < meta.min || hash.digest("hex") !== meta.sha256) {
            fs.unlinkSync(part);
            throw new Error(`模型文件校验失败：${name}`);
          }
          fs.renameSync(part, dest);
        }
        send({ type: "done" });
      } catch (error) {
        for (const name of Object.keys(LOCAL_ASR_FILES)) {
          try { fs.unlinkSync(path.join(LOCAL_ASR_DIR, name + ".part")); } catch {}
        }
        send({ type: "error", message: error.message });
      } finally { localAsrDownloading = false; res.end(); }
      return;
    }
    if (req.method === "POST" && p === "/api/local-asr/start") {
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      try {
        const source = body.source === "system" ? "system" : "mic";
        const started = await localAsrStartSession({
          source, sourceLabel: source === "system" ? "系统声音（本机识别）" : "麦克风（本机识别）",
          title: String(body.title || "未命名转写").slice(0, 200),
          sourceKey: String(body.sourceKey || "").slice(0, 1200), pageUrl: String(body.pageUrl || "").slice(0, 500),
        });
        return json(res, 200, started);
      } catch (error) { return json(res, 200, { ok: false, error: error.message }); }
    }
    if (req.method === "POST" && p === "/api/local-asr/feed") {
      const session = LOCAL_ASR_SESSIONS.get(u.searchParams.get("sid") || "");
      if (!session) return json(res, 200, { ok: false, stale: true, error: "会话已结束" });
      const body = JSON.parse(await readBody(req, 3 * 1024 * 1024) || "{}");
      const pcm = clientAudioToPcm(body.audio || body);
      if (!pcm) return json(res, 400, { ok: false, error: "音频分片格式无效" });
      if (!session.worker.feed(pcm)) return json(res, 429, { ok: false, error: "本机识别跟不上音频输入" });
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && p === "/api/local-asr/stop") {
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      const sid = String(body.sid || "");
      const session = LOCAL_ASR_SESSIONS.get(sid);
      if (!session) return json(res, 200, { ok: true, note: "会话已结束" });
      session.worker.stop();
      await Promise.race([session.done, new Promise(resolve => setTimeout(resolve, 5000))]);
      session.worker.kill();
      LOCAL_ASR_SESSIONS.delete(sid);
      const rec = session.rec;
      const text = rec.lines.map(line => line.text).join("\n");
      const durationMs = Date.now() - rec.startedAt;
      sttUpd(rec.id, { status: rec.status === "error" ? "error" : "done", endedAt: Date.now(), durationMs, text, lines: rec.lines });
      return json(res, 200, { ok: rec.status !== "error", id: rec.id, lines: rec.lines.length, durationMs, textPreview: text.slice(0, 200) });
    }
    /* ═══════ 豆包语音转写 API ═══════ */
    if (req.method === "GET" && p === "/api/doubao/status") {
      const cfg = doubaoReadConfig();
      return json(res, 200, {
        configured: !!cfg.apiKey,
        resourceId: cfg.resourceId || DOUBAO_DEFAULT_RES,
        resourceIdLabel: DOUBAO_RES_LABELS[cfg.resourceId || DOUBAO_DEFAULT_RES] || cfg.resourceId,
        language: cfg.language || "", speakerInfo: !!cfg.speakerInfo, hotwords: cfg.hotwords || "",
        activeSessions: DOUBAO_SESSIONS.size,
        sttDir: STT_DIR,
      });
    }
    if (req.method === "POST" && p === "/api/doubao/config") {
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      const cfg = doubaoReadConfig();
      if (typeof body.apiKey === "string") cfg.apiKey = body.apiKey.trim();
      if (typeof body.resourceId === "string" && body.resourceId) cfg.resourceId = body.resourceId.trim();
      if (typeof body.language === "string") cfg.language = body.language.trim();
      if (typeof body.speakerInfo === "boolean") cfg.speakerInfo = body.speakerInfo;
      if (typeof body.hotwords === "string") cfg.hotwords = body.hotwords.slice(0, 4000);
      doubaoWriteConfig(cfg);
      return json(res, 200, { ok: true, configured: !!cfg.apiKey, resourceId: cfg.resourceId, language: cfg.language, speakerInfo: cfg.speakerInfo });
    }
    /* ─── 声音路由（BlackHole 助手） ─── */
    if (req.method === "GET" && p === "/api/audio/route-status") {
      if (process.platform !== "darwin") return json(res, 200, { ok: true, platform: process.platform, loopbackSupported: process.platform === "win32", outputs: [], hint: "Windows 在系统声音转写时会显示屏幕共享选择框；选择屏幕并启用系统音频。" });
      const { execFile } = await import("node:child_process");
      const out = await new Promise(resolve => {
        execFile("system_profiler", ["SPAudioDataType"], { maxBuffer: 1024 * 1024 }, (e, stdout) => resolve(e ? "" : String(stdout)));
      });
      const devices = [];
      let cur = null;
      for (const raw of out.split("\n")) {
        const line = raw.replace(/\t/g, " ");
        const dm = line.match(/^ {12}(\S[^:]*):$/);
        if (dm) { cur = { name: dm[1].trim(), defaultOut: false, hasOutput: false }; devices.push(cur); continue; }
        if (!cur) continue;
        if (/Default Output Device: Yes/.test(line)) cur.defaultOut = true;
        const om = line.match(/Output Channels: (\d+)/);
        if (om && +om[1] > 0) cur.hasOutput = true;
      }
      const outputs = devices.filter(d => d.hasOutput);
      const blackhole = devices.find(d => /blackhole/i.test(d.name));
      const multi = outputs.find(d => /multi[- ]?output|多输出/i.test(d.name));
      return json(res, 200, {
        ok: true,
        blackholeInstalled: !!blackhole,
        blackholeName: blackhole?.name || "",
        multiOutputExists: !!multi,
        defaultOutput: (outputs.find(d => d.defaultOut) || {}).name || "",
        outputs: outputs.map(d => d.name).slice(0, 12),
      });
    }
    if (req.method === "POST" && p === "/api/audio/install-blackhole") {
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      if (process.platform !== "darwin") { send({ type: "error", message: "Windows 使用系统音频共享，无需安装 BlackHole。" }); return res.end(); }
      const brew = ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"].find(existsSync);
      if (!brew) { send({ type: "error", message: "未找到 Homebrew。请先安装 Homebrew 后重试，或手动执行 brew install blackhole-2ch" }); return res.end(); }
      send({ type: "phase", phase: "开始安装 BlackHole 2ch（免费开源，约 1-3 分钟）…" });
      const child = spawn(brew, ["install", "blackhole-2ch"]);
      let tail = [];
      const onData = d => {
        for (const l of String(d).split("\n")) {
          const t = l.trim();
          if (!t) continue;
          tail.push(t); if (tail.length > 4) tail.shift();
          if (/Pouring|Installing|installed|linking|Downloading/i.test(t)) send({ type: "phase", phase: t.slice(0, 70) });
        }
      };
      child.stdout.on("data", onData); child.stderr.on("data", onData);
      const killTimer = setTimeout(() => { try { child.kill(); } catch {} }, 10 * 60 * 1000);
      child.on("close", code => {
        clearTimeout(killTimer);
        if (code === 0) send({ type: "done", message: "安装完成。建议重启一次电脑，然后点「打开音频 MIDI 设置」创建多输出设备（同时勾选扬声器 + BlackHole 2ch）" });
        else send({ type: "error", message: "安装失败：" + (tail.join(" | ") || "退出码 " + code) });
        res.end();
      });
      child.on("error", e => { clearTimeout(killTimer); send({ type: "error", message: "启动 brew 失败：" + e.message }); res.end(); });
      return;
    }
    if (req.method === "GET" && p === "/api/audio/open-midi") {
      const { execFile } = await import("node:child_process");
      openSystem(process.platform === "win32" ? "ms-settings:sound" : "", { app: "Audio MIDI Setup" })
        .then(() => json(res, 200, { ok: true }), () => json(res, 500, { error: "打开失败，请手动打开系统声音设置" }));
      return;
    }
    /* ─── 免 Key 文件转写：本地 Whisper 离线 ─── */
    if (req.method === "POST" && p === "/api/stt/whisper-file") {
      const body = JSON.parse(await readBody(req, 220 * 1024 * 1024) || "{}");
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const fail = (msg, kind) => { send({ type: "error", message: msg, kind: kind || "unknown" }); try { res.end(); } catch {} };
      let srcPath = ""; let tmpUp = null;
      try {
        if (body.path) {
          srcPath = resolveStoredPath(String(body.path));
          if (!path.isAbsolute(srcPath) || !existsSync(srcPath)) return fail("文件不存在或路径无效", "input");
        } else {
          const name = String(body.name || "audio").replace(/[/\\:*?<>|]/g, "_").slice(0, 100);
          const bin = Buffer.from(String(body.audioBase64 || ""), "base64");
          if (!bin.length) return fail("没有收到音频数据", "input");
          if (bin.length > 150 * 1024 * 1024) return fail("文件过大（>150MB），请先剪辑或压缩", "input");
          mkdirSync(STT_DIR, { recursive: true });
          tmpUp = path.join(STT_DIR, "tmp-" + randomUUID().slice(0, 8) + "-" + name.replace(/\s+/g, "_"));
          fs.writeFileSync(tmpUp, bin);
          srcPath = tmpUp;
        }
        const id = randomUUID();
        const rec = {
          id, source: "file", sourceLabel: "本地 Whisper · 离线转写",
          title: String(body.title || path.basename(srcPath).replace(/\.[^.]+$/, "")).slice(0, 200),
          sourceKey: String(body.sourceKey || "").slice(0, 1200), pageUrl: "", startedAt: Date.now(), endedAt: null, durationMs: 0,
          lines: [], status: "recording", engine: "whisper",
          resourceId: "whisper.cpp base", dir: null, errorMessage: "", hint: "",
        };
        mkdirSync(STT_DIR, { recursive: true });
        sttWriteAll([...sttReadAll(), rec]);
        const r = await whisperTranscribeFile(srcPath, {
          modelDir: WHISPER_MODEL_DIR,
          onProgress: ph => send({ type: "phase", phase: ph }),
        });
        const doneStatus = r.lines.length ? "done" : "error";
        sttUpd(id, {
          lines: r.lines, text: r.text, durationMs: r.durationMs, status: doneStatus,
          endedAt: Date.now(), errorMessage: r.lines.length ? "" : "没有识别到语音内容",
        });
        send({ type: "done", id, lines: r.lines.length, durationMs: r.durationMs });
      } catch (e) {
        fail(e.message, e.kind || "unknown");
      } finally {
        if (tmpUp) { try { fs.unlinkSync(tmpUp); } catch {} }
      }
      return;
    }


    /* ─── 背景 DIY API ─── */
    if (req.method === "GET" && p === "/api/bg/list") {
      return json(res, 200, { ok: true, items: bgList() });
    }
    if (req.method === "POST" && p === "/api/bg/upload") {
      const body = JSON.parse(await readBody(req, 26 * 1024 * 1024) || "{}");
      const b64 = String(body.dataBase64 || "");
      const m = b64.match(/^data:(image\/(png|jpeg|webp|gif));base64,(.+)$/);
      if (!m) return json(res, 400, { ok: false, error: "只支持 PNG/JPG/WebP/GIF 图片" });
      mkdirSync(BG_DIR, { recursive: true });
      const name = "bg-" + Date.now() + "." + (m[2] === "jpeg" ? "jpg" : m[2]);
      fs.writeFileSync(path.join(BG_DIR, name), Buffer.from(m[3], "base64"));
      return json(res, 200, { ok: true, name });
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/api/bg/file") {
      const name = path.basename(u.searchParams.get("name") || "");
      const f = path.join(BG_DIR, name);
      if (!BG_EXTS[path.extname(name).toLowerCase()] || !existsSync(f)) return json(res, 404, { error: "not found" });
      res.writeHead(200, { "Content-Type": BG_EXTS[path.extname(name).toLowerCase()], "Cache-Control": "no-store" });
      return createReadStream(f).pipe(res);
    }
    if (req.method === "POST" && p === "/api/bg/delete") {
      const body = JSON.parse(await readBody(req) || "{}");
      const name = path.basename(String(body.name || ""));
      const f = path.join(BG_DIR, name);
      if (BG_EXTS[path.extname(name).toLowerCase()] && existsSync(f)) fs.unlinkSync(f);
      return json(res, 200, { ok: true });
    }

    /* ─── 豆包 APP 自动导入 API ─── */
    if (req.method === "GET" && p === "/api/doubao/watch/status") {
      const st = watchStateRead();
      const importedCount = Object.values(st.seen).filter(v => v.imported).length;
      return json(res, 200, {
        ok: true, dir: DOUBAO_CHATS_DIR, dirExists: existsSync(DOUBAO_CHATS_DIR),
        watching: !!doubaoWatchTimer, importedCount,
        pollMs: 15000,
      });
    }
    if (req.method === "POST" && p === "/api/doubao/watch/scan") {
      /* 手动触发一次扫描（立即回流） */
      const imported = doubaoScanChats();
      return json(res, 200, { ok: true, imported });
    }

    if (req.method === "GET" && p === "/api/doubao/app-check") {
      const { execFile } = await import("node:child_process");
      if (process.platform !== "darwin") return json(res, 200, { ok: true, installed: false, webAvailable: true });
      const installed = await new Promise(resolve => {
        execFile("mdfind", ["kMDItemFSName == 'Doubao.app'"], { timeout: 4000 }, (e, stdout) => {
          if (!e && String(stdout).includes("Doubao.app")) return resolve(true);
          for (const cand of ["/Applications/Doubao.app", "/Applications/豆包.app", path.join(HOME, "Applications/Doubao.app")]) {
            if (existsSync(cand)) return resolve(true);
          }
          resolve(false);
        });
      });
      return json(res, 200, { ok: true, installed });
    }
    if (req.method === "GET" && p === "/api/doubao/resources") {
      return json(res, 200, { ok: true, resources: Object.entries(DOUBAO_RES_LABELS).map(([id, label]) => ({ id, label })) });
    }
    if (req.method === "POST" && p === "/api/doubao/start") {
      const body = JSON.parse(await readBody(req, 262144) || "{}");
      try {
        const r = await doubaoStartSession({
          source: ["mic", "system", "browser", "file"].includes(body.source) ? body.source : "mic",
          sourceLabel: String(body.sourceLabel || "").slice(0, 200),
          title: String(body.title || "").slice(0, 200) || "未命名转写",
          sourceKey: String(body.sourceKey || "").slice(0, 1200), pageUrl: String(body.pageUrl || "").slice(0, 500),
        });
        return json(res, 200, r);
      } catch (e) {
        return json(res, 200, { ok: false, error: e.message, hint: e.hint || "", kind: e.kind || friendlyAsrError(e.message).kind });
      }
    }
    if (req.method === "POST" && p === "/api/doubao/feed") {
      /* 音频分片：JSON(float32 数组 + 采样率) 或 base64 PCM；单请求 ≤ 3MB */
      const sid = u.searchParams.get("sid") || "";
      const S = DOUBAO_SESSIONS.get(sid);
      if (!S) return json(res, 200, { ok: false, error: "会话不存在或已结束", stale: true });
      const body = JSON.parse(await readBody(req, 3 * 1024 * 1024) || "{}");
      const pcm = clientAudioToPcm(body.audio || body);
      if (!pcm) return json(res, 400, { ok: false, error: "音频分片格式无效" });
      doubaoFeed(sid, pcm);
      return json(res, 200, { ok: true, bytes: S.bytes });
    }
    if (req.method === "POST" && p === "/api/doubao/stop") {
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      const S = DOUBAO_SESSIONS.get(String(body.sid || ""));
      if (!S) return json(res, 200, { ok: true, note: "会话已结束" });
      const id = S.id;
      /* 尾句兜底：partial 未定稿时按 final 落一条 */
      if (S.lastPartial?.text) {
        fs.appendFileSync(S.jsonl, JSON.stringify({ ...S.lastPartial, kind: "final" }) + "\n");
        S.rec.lines.push({ ...S.lastPartial, kind: "final" });
      }
      const text = S.rec.lines.map(l => l.text).join("\n");
      const durationMs = Date.now() - S.rec.startedAt;
      await S.session.finish(2000).catch(() => {});
      S.closed = true; DOUBAO_SESSIONS.delete(String(body.sid || ""));
      sttUpd(id, { status: "done", endedAt: Date.now(), durationMs, text });
      return json(res, 200, { ok: true, id, lines: S.rec.lines.length, durationMs, textPreview: text.slice(0, 200) });
    }
    if (req.method === "GET" && p === "/api/doubao/events") {
      /* 转写事件流（partial 累积在客户端；error/closed 推送） */
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      STT_SSE.add(res);
      const dropSttSse = () => STT_SSE.delete(res);
      req.on("close", dropSttSse);
      res.on("close", dropSttSse);   /* 双保险：断开的订阅必须移出群发集合，防泄漏与向死连接写入 */
      return;
    }
    /* ─── 台账 ─── */
    if (req.method === "GET" && p === "/api/transcripts") {
      const list = sttReadAll().map(r => ({ ...r, lines: undefined }));
      list.sort((a, b) => b.startedAt - a.startedAt);
      return json(res, 200, { ok: true, items: list });
    }
    if (req.method === "GET" && p === "/api/transcripts/search") {
      /* 台账关键词搜索：匹配标题 / 正文 / 分句文本 */
      const q = (u.searchParams.get("q") || "").trim().toLowerCase();
      if (!q) return json(res, 200, { ok: true, items: sttReadAll().slice().sort((a, b) => b.startedAt - a.startedAt).map(r => ({ ...r, lines: undefined })) });
      const kws = q.split(/\s+/).filter(Boolean);
      const hits = sttReadAll().filter(r => {
        const hay = [r.title || "", r.text || "", r.sourceLabel || "", ...((r.lines || []).map(l => l.text || ""))].join("\n").toLowerCase();
        return kws.every(k => hay.includes(k));
      }).sort((a, b) => b.startedAt - a.startedAt)
        .map(r => ({ ...r, lines: undefined, snippet: (() => {
          const hay = [r.text || "", ...((r.lines || []).map(l => l.text || ""))].join(" ");
          const i = hay.toLowerCase().indexOf(kws[0]);
          return i >= 0 ? hay.slice(Math.max(0, i - 30), i + 60) : (r.text || "").slice(0, 60);
        })() }));
      return json(res, 200, { ok: true, items: hits, count: hits.length });
    }
    if (req.method === "GET" && p === "/api/transcripts/detail") {
      const id = u.searchParams.get("id") || "";
      const it = sttReadAll().find(x => x.id === id);
      if (!it) return json(res, 404, { error: "记录不存在" });
      return json(res, 200, { ok: true, item: it });
    }
    if (req.method === "POST" && p === "/api/transcripts/update") {
      const body = JSON.parse(await readBody(req, 8 * 1024 * 1024) || "{}");
      const id = String(body.id || "");
      const it = sttReadAll().find(x => x.id === id);
      if (!it) return json(res, 404, { error: "记录不存在" });
      const patch = {};
      if (typeof body.title === "string") patch.title = body.title.slice(0, 200);
      if (body.lines !== undefined) {
        if (!Array.isArray(body.lines) || body.lines.some(l => !l || typeof l.text !== "string" || !Number.isFinite(l.t0) || l.t0 < 0 || !Number.isFinite(l.t1) || l.t1 < l.t0)) {
          return json(res, 400, { error: "分句格式无效，修正未保存" });
        }
        patch.lines = body.lines.map(({ text, t0, t1 }) => ({ text, t0, t1 }));
        patch.text = patch.lines.map(l => l.text).join("\n");
      } else if (typeof body.text === "string") {
        patch.text = body.text;
        patch.lines = []; // 全文替换后不再保留旧分句，避免详情与导出仍显示旧文本。
      }
      if (typeof body.course === "string") patch.course = body.course.slice(0, 80);
      if (typeof body.courseName === "string") patch.courseName = body.courseName.slice(0, 160);
      sttUpd(id, patch);
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/transcripts/stats") {
      /* 多课程学习对比：按 courseName 聚合学习时长（空=未归课），totalMs 降序 */
      const list = sttReadAll();
      const map = new Map();
      for (const r of list){
        const course = String(r.course || "").slice(0, 80);
        const courseName = (String(r.courseName || "").trim()) || "未归课";
        const key = course + "\u0000" + courseName;
        const cur = map.get(key) || { course, courseName, totalMs: 0, count: 0, lastAt: 0 };
        cur.totalMs += Math.max(0, Number(r.durationMs) || 0);
        cur.count += 1;
        cur.lastAt = Math.max(cur.lastAt, Number(r.startedAt) || 0);
        map.set(key, cur);
      }
      const items = [...map.values()].sort((a, b) => b.totalMs - a.totalMs);
      const totalMs = list.reduce((a, r) => a + Math.max(0, Number(r.durationMs) || 0), 0);
      return json(res, 200, { ok: true, items, totalMs });
    }
    if (req.method === "POST" && p === "/api/transcripts/chapters") {
      /* 自动分章：返回 [{ title, t0, t1, lineIdx:[起,止) }]，纯规则（信号词+时间间隔） */
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      const id = String(body.id || "");
      const it = sttReadAll().find(x => x.id === id);
      if (!it) return json(res, 404, { error: "记录不存在" });
      const chapters = detectChapters(it);
      return json(res, 200, { ok: true, chapters });
    }
    if (req.method === "GET" && p === "/api/transcripts/backup") {
      /* 台账一键备份：完整记录（含 lines/text）打包为 JSON 附件下载 */
      const records = sttReadAll();
      const d = new Date();
      const ymd = `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, "0")}${String(d.getDate()).padStart(2, "0")}`;
      const fname = `转写台账备份-${ymd}.json`;
      res.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}`,
      });
      return res.end(JSON.stringify({ app: "studydesk", version: 1, exportedAt: new Date().toISOString(), records }));
    }
    if (req.method === "POST" && p === "/api/transcripts/restore") {
      /* 台账恢复：按 id 合并——已存在跳过，新 id 追加；非法条目跳过；请求体上限 64MB */
      let raw;
      try { raw = await readBody(req, 64 * 1024 * 1024); }
      catch { return json(res, 413, { error: "请求体过大（上限 64MB）" }); }
      let body;
      try { body = JSON.parse(raw || "{}"); }
      catch { return json(res, 400, { error: "不是合法的 JSON" }); }
      const recs = body.records;
      if (!Array.isArray(recs)) return json(res, 400, { error: "records 必须是数组" });
      const okRec = r => r && typeof r === "object" && !Array.isArray(r)
        && typeof r.id === "string" && r.id.trim() && Number.isFinite(r.startedAt)
        && ["title", "text", "source", "sourceLabel", "course", "courseName", "errorMessage", "pageUrl"].every(key => r[key] === undefined || typeof r[key] === "string")
        && (r.lines === undefined || Array.isArray(r.lines) && r.lines.every(l => l && typeof l.text === "string" && Number.isFinite(l.t0) && l.t0 >= 0 && (l.t1 === undefined || Number.isFinite(l.t1) && l.t1 >= l.t0)));
      const list = sttReadAll();
      const have = new Set(list.map(x => x.id));
      let added = 0, skipped = 0;
      for (const r of recs) {
        if (!okRec(r) || !/^[\w-]+$/.test(r.id.trim()) || have.has(r.id.trim())) { skipped++; continue; }
        const id = r.id.trim();
        have.add(id);
        list.push({ ...r, id });
        added++;
      }
      if (added) sttWriteAll(list);
      return json(res, 200, { ok: true, added, skipped });
    }
    if (req.method === "POST" && p === "/api/transcripts/delete") {
      const body = JSON.parse(await readBody(req, 65536) || "{}");
      const id = String(body.id || "");
      if (!/^[\w-]+$/.test(id)) return json(res, 400, { error: "记录 ID 无效" });
      const list = sttReadAll().filter(x => x.id !== id);
      sttWriteAll(list);
      try { fs.unlinkSync(path.join(STT_DIR, id + ".jsonl")); } catch {}
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/transcripts/export") {
      const id = u.searchParams.get("id") || "";
      const fmt = (u.searchParams.get("fmt") || "txt").toLowerCase();
      const courseFilter = u.searchParams.get("course") || "";
      /* 按课程批量导出：course=课程id（或 "all" 全部带课程标记的） */
      if (courseFilter){
        const all = sttReadAll().filter(x => courseFilter === "all" ? !!x.course : x.course === courseFilter);
        if (!all.length) return json(res, 404, { error: "该课程下还没有转写记录" });
        all.sort((a, b) => a.startedAt - b.startedAt);
        const stamp2 = t => { const s = Math.max(0, Math.round((t || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
        const courseName = all[0].courseName || "课程";
        let body = `# ${courseName} · 转写合集\n\n导出时间：${new Date().toLocaleString("zh-CN")} · 共 ${all.length} 条记录\n\n---\n\n`;
        for (const it of all){
          body += `## ${it.title}\n\n`;
          body += `> ${new Date(it.startedAt).toLocaleString("zh-CN")} · 时长 ${fmtTsdur(it.durationMs || 0)} · ${it.sourceLabel || it.source}\n\n`;
          if (it.lines?.length) body += it.lines.map(l => `- **\`${stamp2(l.t0)}\`** ${l.text}`).join("\n");
          else if (it.text) body += it.text.split("\n").map(t => t.trim()).filter(Boolean).map(t => "- " + t).join("\n");
          body += "\n\n";
        }
        const fname = `${courseName}-转写合集.md`;
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(fname)}` });
        return res.end(body);
      }
      const it = sttReadAll().find(x => x.id === id);
      if (!it) return json(res, 404, { error: "记录不存在" });
      const stamp = t => { const s = Math.max(0, Math.round((t || 0) / 1000)); return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`; };
      const head = `${it.title}\n来源：${it.sourceLabel || it.source}${it.pageUrl ? " · " + it.pageUrl : ""}\n时间：${new Date(it.startedAt).toLocaleString("zh-CN")} · 时长 ${fmtTsdur(it.durationMs || 0)}\n引擎：豆包流式语音识别（${DOUBAO_RES_LABELS[it.resourceId] || it.resourceId || ""}）\n${"─".repeat(28)}\n`;
      if (fmt === "txt") {
        const body = (it.lines || []).map(l => `[${stamp(l.t0)}] ${l.text}`).join("\n") || it.text || "";
        res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(it.title + ".txt")}` });
        return res.end(head + body + "\n");
      }
      if (fmt === "md") {
        const body = (it.lines || []).map(l => `- **\`${stamp(l.t0)}\`** ${l.text}`).join("\n") || (it.text || "");
        res.writeHead(200, { "Content-Type": "text/markdown; charset=utf-8", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(it.title + ".md")}` });
        return res.end(head + "\n" + body + "\n");
      }
      if (fmt === "docx") {
        /* 极简 docx：word/document.xml 手拼（标题 + 段落），python-docx 不强依赖 */
        const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
        const paras = [
          `<w:p><w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">${esc(it.title)}</w:t></w:r></w:p>`,
          `<w:p><w:pPr><w:rPr><w:color w:val="888888"/><w:sz w:val="18"/></w:rPr></w:pPr><w:r><w:t xml:space="preserve">${esc(`来源：${it.sourceLabel || it.source}${it.pageUrl ? " · " + it.pageUrl : ""} · ${new Date(it.startedAt).toLocaleString("zh-CN")} · 时长 ${fmtTsdur(it.durationMs || 0)}`)}</w:t></w:r></w:p>`,
          ...(it.lines || []).map(l => `<w:p><w:r><w:rPr><w:rFonts w:eastAsia="PingFang SC"/></w:rPr><w:t xml:space="preserve">${esc(`[${stamp(l.t0)}] `)}</w:t></w:r><w:r><w:t xml:space="preserve">${esc(l.text)}</w:t></w:r></w:p>`),
        ];
        if (!it.lines?.length && it.text) paras.push(`<w:p><w:r><w:t xml:space="preserve">${esc(it.text)}</w:t></w:r></w:p>`);
        const docXml = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paras.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`;
        const zip = new Map([
          ["[Content_Types].xml", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`],
          ["_rels/.rels", `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`],
          ["word/document.xml", docXml],
        ]);
        const { zipStore } = await import("./lib/zip-store.mjs");
        const buf = zipStore(zip);
        res.writeHead(200, { "Content-Type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(it.title + ".docx")}` });
        return res.end(buf);
      }
      return json(res, 400, { error: "不支持的导出格式" });
    }
    /* ─── 文件转写（上传音视频 → ffmpeg 抽 16k PCM → 豆包 → 台账） ─── */
    if (req.method === "POST" && p === "/api/doubao/transcribe-file") {
      const body = JSON.parse(await readBody(req, 220 * 1024 * 1024) || "{}");
      const name = String(body.name || "音频文件").replace(/[/\\:*?<>|]/g, "_").slice(0, 100);
      const b64 = String(body.audioBase64 || "");
      if (!b64) return json(res, 400, { ok: false, error: "没有收到音频数据" });
      const bin = Buffer.from(b64, "base64");
      if (bin.length > 150 * 1024 * 1024) return json(res, 400, { ok: false, error: "文件过大（>150MB），请先压缩或剪辑" });
      const ff = findFfmpeg();
      if (!ff) return json(res, 500, { ok: false, error: "未找到 ffmpeg，无法解码音频。请执行：brew install ffmpeg" });
      const cfg = doubaoReadConfig();
      if (!cfg.apiKey) return json(res, 200, { ok: false, kind: "config", error: "尚未配置豆包 API Key" });
      const tmpIn = path.join(STT_DIR, "tmp-" + randomUUID().slice(0, 8) + "-" + name.replace(/\s+/g, "_"));
      const tmpPcm = tmpIn + ".pcm";
      mkdirSync(STT_DIR, { recursive: true });
      fs.writeFileSync(tmpIn, bin);
      const ffmpegDone = new Promise((resolve, reject) => {
        const p = spawn(ff, ["-y", "-i", tmpIn, "-ar", "16000", "-ac", "1", "-f", "s16le", "-v", "error", tmpPcm]);
        p.on("close", c => c === 0 ? resolve() : reject(new Error("ffmpeg 解码失败（退出码 " + c + "），请确认是有效的音视频文件")));
        p.on("error", reject);
      });
      try { await ffmpegDone; } catch (e) {
        try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpPcm); } catch {}
        return json(res, 400, { ok: false, error: e.message });
      }
      const pcm = fs.readFileSync(tmpPcm);
      try { fs.unlinkSync(tmpIn); fs.unlinkSync(tmpPcm); } catch {}
      /* 建会话送识别（复用会话通道，文件一次喂完） */
      const started = await doubaoStartSession({ source: "file", sourceLabel: name, title: name.replace(/\.[^.]+$/, "") });
      if (!started.ok) return json(res, 200, started);
      const S = DOUBAO_SESSIONS.get(started.sid);
      const CHUNK = 32000; /* 1 秒音频 */
      for (let off = 0; off < pcm.length; off += CHUNK) {
        doubaoFeed(started.sid, pcm.subarray(off, Math.min(pcm.length, off + CHUNK)));
        if (off % (CHUNK * 30) === 0) await new Promise(r => setTimeout(r, 30)); /* 每 30 秒喘口气 */
      }
      /* 等识别收敛：轮询直到会话关闭或超时（音频时长 * 0.6 + 20s） */
      const waitMs = Math.min(60 * 60000, Math.round(pcm.length / 32 / 1000 * 0.6 + 20000));
      const t0 = Date.now();
      while (DOUBAO_SESSIONS.has(started.sid) && Date.now() - t0 < waitMs) await new Promise(r => setTimeout(r, 400));
      const it = sttReadAll().find(x => x.id === started.id) || {};
      if (S && !S.closed) { /* 超时兜底收尾 */
        try { S.session.abort(); } catch {}
        DOUBAO_SESSIONS.delete(started.sid);
        const text = S.rec.lines.map(l => l.text).join("\n");
        sttUpd(started.id, { status: S.rec.lines.length ? "done" : "error", endedAt: Date.now(), durationMs: Date.now() - S.rec.startedAt, text, errorMessage: S.rec.lines.length ? "" : "识别超时，请重试" });
      }
      return json(res, 200, { ok: true, id: started.id, lines: (it.lines || []).length, status: sttReadAll().find(x => x.id === started.id)?.status });
    }

    if (req.method === "GET" && p === "/api/version") {
      /* 界面文件变化 → 前端热更新轮询用 */
      try { return json(res, 200, { v: statSync(HTML_FILE).mtimeMs }); }
      catch { return json(res, 200, { v: 0 }); }
    }
    if (req.method === "GET" && p === "/api/search") {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      const qRaw = u.searchParams.get("q") ?? "";
      if (qRaw.length > 200) return json(res, 400, { ok: false, error: "q 最长 200 字符" });
      return json(res, 200, await deskSearch(qRaw));
    }
    /* ═══════ 笔记数据库 API（SQLite，参数绑定） ═══════ */
    if (p === "/api/notes" || p.startsWith("/api/notes/")) {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (req.method === "GET" && p === "/api/notes/status") {
        const db = notesOpen();
        if (!db) return json(res, 200, { ok: true, available: false, error: notesDbError });
        return json(res, 200, { ok: true, available: true, count: db.prepare("SELECT COUNT(*) AS n FROM notes").get().n, file: NOTES_DB_FILE });
      }
      const db = notesOpen();
      if (!db) return json(res, 503, { ok: false, error: notesDbError || "笔记库不可用" });
      if (req.method === "GET" && p === "/api/notes/index") {
        const rows = db.prepare("SELECT context_key, saved_at FROM notes").all();
        return json(res, 200, { ok: true, items: rows.map(r => [r.context_key, r.saved_at]) });
      }
      if (req.method === "GET" && p === "/api/notes/list") {
        const q = (u.searchParams.get("q") || "").trim();
        const limit = Math.min(Math.max(Number(u.searchParams.get("limit")) || 200, 1), 1000);
        const cols = "context_key, name, kind, source, course_id, course_name, tags, status, text_plain, word_count, saved_at, created_at, updated_at, revision";
        let rows;
        if (q) {
          const pat = `%${escapeLike(q)}%`;
          rows = db.prepare(`SELECT ${cols} FROM notes
            WHERE name LIKE ? ESCAPE '\\' OR text_plain LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\' OR course_name LIKE ? ESCAPE '\\'
            ORDER BY updated_at DESC LIMIT ?`).all(pat, pat, pat, pat, limit);
        } else {
          rows = db.prepare(`SELECT ${cols} FROM notes ORDER BY updated_at DESC LIMIT ?`).all(limit);
        }
        return json(res, 200, { ok: true, items: rows.map(r => noteRowOf(r)) });
      }
      if (req.method === "GET" && p === "/api/notes/detail") {
        const row = db.prepare("SELECT * FROM notes WHERE context_key = ?").get((u.searchParams.get("key") || "").slice(0, 1200));
        if (!row) return json(res, 404, { ok: false, error: "笔记不存在" });
        return json(res, 200, { ok: true, item: noteRowOf(row, true) });
      }
      if (req.method === "GET" && p === "/api/notes/export") {
        const rows = db.prepare("SELECT * FROM notes").all();
        return json(res, 200, { app: "studydesk-notes", version: 1, exportedAt: new Date().toISOString(), notes: rows.map(r => noteRowOf(r, true)) });
      }
      if (req.method === "GET" && p === "/api/notes/revisions") {
        const rows = db.prepare("SELECT id, saved_at, created_at, length(html) AS bytes FROM note_revisions WHERE context_key = ? ORDER BY id DESC LIMIT 100")
          .all((u.searchParams.get("key") || "").slice(0, 1200));
        return json(res, 200, { ok: true, items: rows.map(r => ({ id: r.id, savedAt: r.saved_at, createdAt: r.created_at, bytes: r.bytes })) });
      }
      if (req.method === "POST" && p === "/api/notes/save") {
        const body = JSON.parse(await readBody(req, 12 * 1024 * 1024) || "{}");
        const key = String(body.key || "").slice(0, 1200);
        if (!key) return json(res, 400, { ok: false, error: "缺少笔记标识 key" });
        const rec = {
          key,
          html: String(typeof body.html === "string" ? body.html : "").slice(0, 8 * 1024 * 1024),
          savedAt: Math.max(0, Math.floor(Number(body.savedAt) || Date.now())),
          name: String(body.name || "").slice(0, 400),
          kind: String(body.kind || "note").slice(0, 32),
          source: String(body.source || "").slice(0, 2400),
          courseId: String(body.courseId || "").slice(0, 120),
          courseName: String(body.courseName || "").slice(0, 400),
          status: ["new", "learning", "done"].includes(body.status) ? body.status : "new",
          tagsJson: JSON.stringify(Array.isArray(body.tags) ? body.tags.map(t => String(t).slice(0, 80)).slice(0, 32) : []),
        };
        return json(res, 200, { ok: true, ...notesSaveRecord(rec) });
      }
      if (req.method === "POST" && p === "/api/notes/import") {
        const body = JSON.parse(await readBody(req, 64 * 1024 * 1024) || "{}");
        const list = Array.isArray(body.notes) ? body.notes.slice(0, 20000) : [];
        let added = 0, updated = 0, skipped = 0;
        for (const n of list) {
          if (!n || typeof n.key !== "string" || !n.key || typeof n.html !== "string" || !(Number(n.savedAt) > 0)) { skipped++; continue; }
          const rec = {
            key: n.key.slice(0, 1200),
            html: n.html.slice(0, 8 * 1024 * 1024),
            savedAt: Math.max(0, Math.floor(Number(n.savedAt))),
            name: String(n.name || "").slice(0, 400),
            kind: String(n.kind || "note").slice(0, 32),
            source: String(n.source || "").slice(0, 2400),
            courseId: String(n.courseId || "").slice(0, 120),
            courseName: String(n.courseName || "").slice(0, 400),
            status: ["new", "learning", "done"].includes(n.status) ? n.status : "new",
            tagsJson: JSON.stringify(Array.isArray(n.tags) ? n.tags.map(t => String(t).slice(0, 80)).slice(0, 32) : []),
          };
          const r = notesSaveRecord(rec, { touchRevision: false });
          if (!r.changed) skipped++;
          else if (r.revision === 1) added++;
          else updated++;
        }
        return json(res, 200, { ok: true, added, updated, skipped });
      }
      if (req.method === "POST" && p === "/api/notes/delete") {
        const body = JSON.parse(await readBody(req, 65536) || "{}");
        const key = String(body.key || "").slice(0, 1200);
        if (!key) return json(res, 400, { ok: false, error: "缺少 key" });
        db.prepare("DELETE FROM notes WHERE context_key = ?").run(key);
        db.prepare("DELETE FROM note_revisions WHERE context_key = ?").run(key);
        return json(res, 200, { ok: true });
      }
      if (req.method === "POST" && p === "/api/notes/restore") {
        const body = JSON.parse(await readBody(req, 65536) || "{}");
        const row = db.prepare("SELECT html, saved_at FROM note_revisions WHERE context_key = ? AND id = ?")
          .get(String(body.key || "").slice(0, 1200), Math.floor(Number(body.id) || 0));
        if (!row) return json(res, 404, { ok: false, error: "历史版本不存在" });
        return json(res, 200, { ok: true, html: row.html, savedAt: row.saved_at });
      }
      return json(res, 404, { error: "not found" });
    }
    /* ═══════ 网页兼容模式（本地反代） API ═══════ */
    if (p === "/api/proxy/status" || p === "/api/proxy/allow" || p === "/api/proxy/disallow") {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (req.method === "GET" && p === "/api/proxy/status") {
        return json(res, 200, { ok: true, allowed: PROXY_STATE.allowed, learned: PROXY_STATE.learned, cookies: proxyCookieJar.counts() });
      }
      if (req.method === "POST") {
        const body = JSON.parse(await readBody(req, 65536) || "{}");
        const host = normalizeProxyHost(body.host);
        if (!host) return json(res, 400, { ok: false, error: "无效的域名" });
        if (p === "/api/proxy/allow") {
          PROXY_STATE.allowed = [...new Set([...PROXY_STATE.allowed, host])];
          PROXY_STATE.learned = PROXY_STATE.learned.filter(h => h !== host);
        } else {
          PROXY_STATE.allowed = PROXY_STATE.allowed.filter(h => h !== host);
          PROXY_STATE.learned = PROXY_STATE.learned.filter(h => h !== host);
          proxyCookieJar.forget(host);
        }
        proxyPersistHosts();
        return json(res, 200, { ok: true, host, allowed: PROXY_STATE.allowed, learned: PROXY_STATE.learned });
      }
    }
    if (p.startsWith(PROXY_API_PREFIX + "/")) return await proxyHandle(req, res, u);
    if (req.method === "GET" && p.startsWith("/vendor/")) {
      const vendorFile = path.join(ROOT, "vendor", path.basename(p));   /* 只取文件名，防目录穿越 */
      if (!existsSync(vendorFile)) return json(res, 404, { error: "not found" });
      const mime = p.endsWith(".js") ? "application/javascript; charset=utf-8" : "application/octet-stream";
      res.writeHead(200, { "Content-Type": mime, "Cache-Control": "no-store" });
      return createReadStream(vendorFile).pipe(res);
    }
    if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
    if (req.method === "GET" && p === "/api/mcp/servers") {
      const cfg = mcpReadConfig();
      return json(res, 200, {
        servers: cfg.servers.map(s => {
          const entry = mcpClients.get(s.name);
          return {
            name: s.name,
            transport: s.transport,
            status: entry?.status || "disconnected",
            error: entry?.error || null,
            tools: entry?.tools || [],
          };
        }),
        configFile: MCP_CONFIG_FILE,
      });
    }
    if (req.method === "POST" && p === "/api/mcp/add") {
      const body = JSON.parse(await readBody(req) || "{}");
      const name = String(body.name || "").trim().slice(0, 60);
      if (!name) return json(res, 400, { ok: false, error: "请填写名称" });
      const cfg = mcpReadConfig();
      if (cfg.servers.some(s => s.name === name)) return json(res, 400, { ok: false, error: "同名服务已存在" });
      let transport;
      if (body.type === "http") {
        let url;
        try { url = new URL(String(body.url || "")); } catch { return json(res, 400, { ok: false, error: "服务地址无效" }); }
        if (!["http:", "https:"].includes(url.protocol)) return json(res, 400, { ok: false, error: "只支持 http(s) 地址" });
        transport = { type: "http", url: url.href };
      } else {
        const parts = splitCommandLine(body.commandLine);
        if (!parts.length) return json(res, 400, { ok: false, error: "请填写启动命令" });
        const command = parts[0].startsWith("~") ? path.join(HOME, parts[0].slice(1)) : parts[0];
        const args = parts.slice(1).map(a => a === "~" ? HOME : (a.startsWith("~/") ? path.join(HOME, a.slice(2)) : a));
        transport = { type: "stdio", command, args };
      }
      cfg.servers.push({ name, transport });
      mcpWriteConfig(cfg);
      const r = await mcpConnect(name);
      return json(res, 200, { ok: true, connected: r.ok, error: r.error || null });
    }
    if (req.method === "POST" && p === "/api/mcp/remove") {
      const body = JSON.parse(await readBody(req) || "{}");
      const name = String(body.name || "");
      mcpDisconnect(name);
      const cfg = mcpReadConfig();
      cfg.servers = cfg.servers.filter(s => s.name !== name);
      mcpWriteConfig(cfg);
      mcpClients.delete(name);
      return json(res, 200, { ok: true });
    }
    if (req.method === "POST" && (p === "/api/mcp/connect" || p === "/api/mcp/disconnect")) {
      const body = JSON.parse(await readBody(req) || "{}");
      const name = String(body.name || "");
      if (p === "/api/mcp/disconnect") { mcpDisconnect(name); return json(res, 200, { ok: true }); }
      const r = await mcpConnect(name);
      return json(res, 200, r);
    }
    if (req.method === "POST" && p === "/api/mcp/call") {
      const body = JSON.parse(await readBody(req, 1024 * 1024) || "{}");
      const name = String(body.server || "");
      const entry = mcpClients.get(name);
      if (!entry?.client || entry.status !== "connected") return json(res, 400, { ok: false, error: "服务未连接，请先在「服务」里连接" });
      try {
        const result = await entry.client.callTool(String(body.tool || ""), body.args || {});
        return json(res, 200, { ok: true, result });
      } catch (e) {
        return json(res, 200, { ok: false, error: String(e.message || e) });
      }
    }
    if (p === "/api/vault" || p.startsWith("/api/vault/")) {
      if (!sameOrigin(req)) return json(res, 403, { error: "forbidden" });
      if (p === "/api/vault/status") {
        try { const r = await vaultFetch("/ping", { timeoutMs: 1500 }); const b = await r.json(); return json(res, 200, { ok: true, ...b, port: VAULT_PORT }); }
        catch { return json(res, 200, { ok: false, port: VAULT_PORT }); }
      }
      if (req.method === "GET" && p === "/api/vault/search") {
        const q = encodeURIComponent(u.searchParams.get("q") || "");
        const limit = Number(u.searchParams.get("limit")) || 50;
        const cat = encodeURIComponent(u.searchParams.get("category") || "");
        return vaultProxy(res, `/search?q=${q}&limit=${limit}${cat ? `&category=${cat}` : ""}`);
      }
      if (req.method === "GET" && p === "/api/vault/recent") {
        const cat = encodeURIComponent(u.searchParams.get("category") || "");
        return vaultProxy(res, `/recent?limit=${Number(u.searchParams.get("limit")) || 20}${cat ? `&category=${cat}` : ""}`);
      }
      const vaultId = p.match(/^\/api\/vault\/item\/([\w-]+)$/);
      if (req.method === "GET" && vaultId) return vaultProxy(res, `/item/${vaultId[1]}`);
      if (req.method === "POST" && vaultId) {
        const body = JSON.parse(await readBody(req, 4096) || "{}");
        /* 桥的打开端点是 /open（body 带 id）；工作台对外保持 POST /api/vault/item/:id 契约。
           id 以 URL 路径为准，body 里的 id 不得覆盖路由目标。 */
        return vaultProxy(res, `/open`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ...body, id: vaultId[1] }) });
      }
      if (req.method === "POST" && p === "/api/vault/ingest") {
        const body = JSON.parse(await readBody(req, 1024 * 1024) || "{}");
        return vaultProxy(res, "/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      if (req.method === "GET" && p === "/api/vault/categories") {
        return vaultProxy(res, `/categories`);
      }
      if (req.method === "POST" && p === "/api/vault/progress") {
        const body = JSON.parse(await readBody(req, 4096) || "{}");
        return vaultProxy(res, "/progress", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      if (req.method === "POST" && p === "/api/vault/card") {
        const body = JSON.parse(await readBody(req, 16384) || "{}");
        let saved = null;
        try { saved = await reviewQueue.save(body); }
        catch (e) { if (e.status) return json(res, e.status, { ok: false, error: e.message }); throw e; }
        try {
          const r = await vaultFetch("/card", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), timeoutMs: 1500 });
          const text = await r.text();
          if (r.ok) {
            res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(text);
          }
        } catch {}
        if (saved) return json(res, 200, { ok: true, id: saved.id, local: true, deduped: !!saved.deduped });
        return json(res, 502, { error: "无法连接学习资产库（8791）——请确认「学习资产库」应用正在运行" });
      }
      if (req.method === "GET" && p === "/api/vault/due") {
        try {
          const qs = new URLSearchParams(u.searchParams);
          qs.delete("sd_token");
          const s = qs.toString();
          const r = await vaultFetch("/review/due" + (s ? "?" + s : ""), { timeoutMs: 1500 });
          const text = await r.text();
          if (r.ok) {
            res.writeHead(r.status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
            return res.end(text);
          }
        } catch {}
        /* 资产库还没有复习接口时，用工作台自己的队列。规则仍是资产库的 srs.js。 */
        return json(res, 200, reviewQueue.due());
      }
      if (req.method === "POST" && p === "/api/vault/grade") {
        const raw = await readBody(req, 4096);
        let body = null;
        try { body = JSON.parse(raw || "{}"); } catch { body = null; }
        if (body && reviewQueue.has(body.cardId)) {
          try { return json(res, 200, await reviewQueue.grade(body.cardId, body.grade)); }
          catch (e) { if (e.status) return json(res, e.status, { ok: false, error: e.message }); throw e; }
        }
        return vaultProxy(res, "/review/grade", { method: "POST", headers: { "Content-Type": "application/json" }, body: raw });
      }
      if (req.method === "POST" && p === "/api/vault/idea") {
        const body = JSON.parse(await readBody(req, 16384) || "{}");
        return vaultProxy(res, "/ideas", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
      }
      return json(res, 404, { error: "not found" });
    }
    if (req.method === "GET" && p === "/api/list") {
      const dir = u.searchParams.get("dir") || DEFAULT_DIR;
      if (dir.includes("\0") || dir.length > 4096) return json(res, 400, { error: "路径无效" });   /* 防 NUL/超长路径打到 readdir 抛内部错误 */
      try { return json(res, 200, listDir(dir)); }
      catch (e) { return json(res, 400, { error: "无法读取该文件夹（" + (e.code || "错误") + "）" }); }   /* 只回显错误码，不回显路径 */
    }
    if (req.method === "GET" && p === "/api/media") {
      const file = u.searchParams.get("path") || "";
      if (!path.isAbsolute(file)) return json(res, 400, { error: "bad path" });
      return serveMedia(req, res, file);
    }
    if (req.method === "GET" && p === "/api/bili-check") {
      return json(res, 200, { ytdlp: existsSync(YTDLP), ffmpeg: findFfmpeg(), cookies: existsSync(COOKIE_FILE), downloadDir: DOWNLOAD_DIR });
    }
    if (req.method === "GET" && p === "/api/docsig") {
      const file = u.searchParams.get("path") || "";
      if (!path.isAbsolute(file) || !DOC_EXTS.has(path.extname(file).toLowerCase())) return json(res, 400, { error: "bad doc path" });
      return json(res, 200, { sig: liveSig(file) });
    }
    if (req.method === "GET" && p === "/api/docfile") {
      const file = u.searchParams.get("path") || "";
      if (!path.isAbsolute(file) || !DOC_EXTS.has(path.extname(file).toLowerCase())) return json(res, 400, { error: "bad doc path" });
      if (liveSig(file) !== u.searchParams.get("s")) return json(res, 403, { error: "bad signature" });
      return serveMedia(req, res, file);   /* 复用 Range 流式（PDF 需要；docx 一次性读） */
    }
    if (req.method === "GET" && p === "/api/filestat") {
      const file = u.searchParams.get("path") || "";
      if (!path.isAbsolute(file)) return json(res, 400, { error: "bad path" });
      try { const st = statSync(file); return json(res, 200, { mtimeMs: st.mtimeMs, size: st.size }); }
      catch { return json(res, 404, { error: "gone" }); }
    }
    if (req.method === "POST" && p === "/api/docsave") {
      /* 把工作台里编辑后的内容写回原 docx（字节体） */
      const file = u.searchParams.get("path") || "";
      if (!path.isAbsolute(file) || path.extname(file).toLowerCase() !== ".docx") return json(res, 400, { error: "只支持回写 .docx" });
      if (!existsSync(file)) return json(res, 404, { error: "文件不存在（只允许回写已打开过的文档）" });   /* 防在任意位置创建新文件 */
      if (liveSig(file) !== u.searchParams.get("s")) return json(res, 403, { error: "bad signature" });
      const chunks = []; let size = 0;
      for await (const c of req) { size += c.length; if (size > 30 * 1024 * 1024) { return json(res, 413, { error: "文件过大" }); } chunks.push(c); }
      if (!chunks.length) return json(res, 400, { error: "空内容" });
      try {
        fs.writeFileSync(file, Buffer.concat(chunks));
        return json(res, 200, { ok: true, mtimeMs: statSync(file).mtimeMs });
      } catch (e) { return json(res, 500, { error: "写入失败：" + e.message }); }
    }
    if (req.method === "GET" && p === "/api/open-live-app") {
      /* 一键唤起外部转写/会议工具：按候选名依次尝试 open -a；tool=folder 打开直播保存目录 */
      const tool = u.searchParams.get("tool") || "";
      if (tool === "folder"){
        const dir = path.join(DEFAULT_DIR, "live");
        mkdirSync(dir, { recursive: true });
        const { execFile } = await import("node:child_process");
        await openSystem(dir);
        return json(res, 200, { ok: true, opened: process.platform === "win32" ? "Explorer" : "Finder" });
      }
      const CANDIDATES = {
        doubao: { names: ["Doubao", "豆包"], web: "https://www.doubao.com/chat/" },
        feishu: { names: ["Lark", "飞书", "Feishu"], web: "https://www.feishu.cn/minutes" },
        qwen:   { names: ["Qwen", "通义千问"], web: "https://chat.qwen.ai/" },
        wemeet: { names: ["腾讯会议", "Tencent Meeting", "WeMeet"], web: "https://meeting.tencent.com/" },
      }[tool];
      if (!CANDIDATES) return json(res, 400, { error: "未知工具" });
      const { execFile } = await import("node:child_process");
      const tryOpen = name => new Promise(resolve => {
        execFile("open", ["-a", name], err => resolve(!err));
      });
      for (const name of process.platform === "darwin" ? CANDIDATES.names : []) {
        if (await tryOpen(name)) return json(res, 200, { ok: true, opened: name });
      }
      try {
        await openLocalWindow(CANDIDATES.web, HOME);
        return json(res, 200, { ok: false, openedWeb: CANDIDATES.web, hint: `本机未安装${CANDIDATES.names[0]}，已在本地应用中打开网页版` });
      } catch (e) {
        return json(res, 200, { ok: false, error: `本机未安装${CANDIDATES.names[0]}，本地应用窗口未就绪` });
      }
    }
    if (req.method === "POST" && p === "/api/live/save") {
      /* 直播课堂落盘：录音 + 转写 + 打点 → downloads/live/<名称>/ */
      const body = JSON.parse(await readBody(req, 80 * 1024 * 1024) || "{}");
      if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "请求体无效" });
      let safe = typeof body.name === "string" ? body.name.replace(/[/\\:*?<>|]/g, "_").replace(/^\.+/, "").slice(0, 60).trim() || "直播学习" : "直播学习";
      if (safe === "." || safe === "..") safe = "直播学习";   /* 防目录逃逸出 live/ */
      const dir = path.join(DEFAULT_DIR, "live", safe);
      mkdirSync(dir, { recursive: true });
      const files = {};
      if (body.audioBase64 != null) {
        if (typeof body.audioBase64 !== "string") return json(res, 400, { error: "audioBase64 必须是字符串" });
        const buf = Buffer.from(body.audioBase64, "base64");
        if (buf.toString("base64").replace(/\s/g, "") !== body.audioBase64.replace(/\s/g, "")) return json(res, 400, { error: "audioBase64 不是合法的 base64" });
        fs.writeFileSync(path.join(dir, "录音.webm"), buf);
        files.audio = path.join(dir, "录音.webm");
      }
      if (body.transcript) {
        fs.writeFileSync(path.join(dir, "转写.txt"), String(body.transcript), "utf8");
        files.transcript = path.join(dir, "转写.txt");
      }
      if (body.marks) {
        fs.writeFileSync(path.join(dir, "打点.json"), JSON.stringify(body.marks, null, 2), "utf8");
        files.marks = path.join(dir, "打点.json");
      }
      return json(res, 200, { ok: true, dir, files });
    }
    if (req.method === "GET" && p === "/api/open-app-window") {
      /* 独立窗口开在本地应用里，登录状态留在应用内。 */
      let url = u.searchParams.get("url") || "";
      const meeting = u.searchParams.get("meeting");   /* 腾讯会议号：唤起会议客户端 */
      if (meeting){
        /* 只放行会议号数字：open 的目标不能是任意 URL / 路径 / scheme */
        const num = meeting.replace(/[^0-9]/g, "").slice(0, 20);
        if (!num) return json(res, 400, { error: "会议号无效" });
        const { execFile } = await import("node:child_process");
        openSystem(`wemeet://page/inmeeting?meeting_code=${num}`).then(() => json(res, 200, { ok: true, opened: "wemeet" }), async err => {
          if (!err) return json(res, 200, { ok: true, mode: "client" });
          try {
            await openLocalWindow(`https://meeting.tencent.com/join/${num}`, HOME);
            return json(res, 200, { ok: true, mode: "web-join", hint: "未检测到会议客户端，已在本地应用中打开入会页" });
          } catch (e) {
            return json(res, 200, { ok: false, error: e.message || "本地应用窗口未就绪" });
          }
        });
        return;
      }
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "无效链接" });
      try {
        return json(res, 200, await openLocalWindow(url, HOME));
      } catch (e) {
        return json(res, 503, { ok: false, error: e.message || "本地应用窗口未就绪" });
      }
    }
    if (req.method === "POST" && p === "/api/live/delete") {
      /* 删除直播会话目录：仅允许 downloads/live/ 下的会话文件夹，防止误删其他文件 */
      const body = JSON.parse(await readBody(req) || "{}");
      const liveRoot = path.resolve(path.join(DEFAULT_DIR, "live"));
      const target = resolveStoredPath(path.resolve(String(body.dir || "")));
      if (!target.startsWith(liveRoot + path.sep)) return json(res, 403, { error: "只能删除直播录音目录" });
      fs.rmSync(target, { recursive: true, force: true });
      return json(res, 200, { ok: true });
    }
    if (req.method === "GET" && p === "/api/whisper/status") {
      /* 本地 Whisper 精转：引擎与模型状态 */
      const bin = findWhisperBin();
      mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
      const models = Object.entries(WHISPER_MODELS).map(([name, m]) => {
        const f = path.join(WHISPER_MODEL_DIR, m.file);
        const ok = existsSync(f);
        return { name, label: m.label, exists: ok, size: ok ? statSync(f).size : 0 };
      });
      return json(res, 200, { engine: bin, models });
    }
    if (req.method === "GET" && p === "/api/whisper/model") {
      /* 下载 Whisper 模型（SSE 进度） */
      const name = u.searchParams.get("name") || "base";
      const m = WHISPER_MODELS[name];
      if (!m) return json(res, 400, { error: "未知模型" });
      mkdirSync(WHISPER_MODEL_DIR, { recursive: true });
      const dest = path.join(WHISPER_MODEL_DIR, m.file);
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const send = obj => { if (!res.destroyed) res.write(`data: ${JSON.stringify(obj)}\n\n`); };
      const dlAbort = new AbortController();
      res.on("close", () => dlAbort.abort());   /* 客户端断开 → 中止上游下载，不悬挂 socket */
      try {
        if (existsSync(dest) && statSync(dest).size > 1000000) { send({ type: "done", path: dest }); res.end(); return; }
        send({ type: "phase", phase: "连接镜像…" });
        const r = await fetch(m.url, { redirect: "follow", signal: dlAbort.signal });
        if (!r.ok) throw new Error("镜像返回 " + r.status);
        const total = +(r.headers.get("content-length") || 0) || m.approx || 0;
        let got = 0, lastPct = -5, clientGone = false;
        res.on("close", () => { clientGone = true; });
        /* 先写 .part 临时文件，完成后原子改名：中断不会留下被误认为完整的残文件 */
        const part = dest + ".part";
        const ws = fs.createWriteStream(part);
        ws.on("error", () => {});
        const { Readable } = await import("node:stream");
        const reader = r.body.getReader();
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (clientGone) { try { reader.cancel(); } catch {} throw new Error("下载已取消"); }
          ws.write(Buffer.from(value));
          got += value.length;
          const pct = total ? Math.floor(got / total * 100) : 0;
          if (pct >= lastPct + 5){ lastPct = pct; send({ type: "progress", pct, got, total }); }
        }
        ws.end();
        await new Promise(r2 => ws.on("close", r2));
        fs.renameSync(part, dest);
        send({ type: "done", path: dest });
      } catch (e) {
        try { fs.unlinkSync(dest + ".part"); } catch {}
        send({ type: "error", message: String(e.message || e) });
      }
      res.end();
      return;
    }
    if (req.method === "POST" && p === "/api/live/whisper") {
      /* 对已保存的直播录音做离线精转（SSE 进度） */
      const body = JSON.parse(await readBody(req) || "{}");
      const dir = resolveStoredPath(path.resolve(String(body.dir || "")));
      const liveRoot = path.resolve(path.join(DEFAULT_DIR, "live"));
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-store", Connection: "keep-alive" });
      const send = obj => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      const fail = msg => { send({ type: "error", message: msg }); res.end(); };
      if (!dir.startsWith(liveRoot + path.sep)) return fail("只能精转直播录音目录");
      const audio = path.join(dir, "录音.webm");
      if (!existsSync(audio)) return fail("目录里没有录音.webm");
      const bin = findWhisperBin();
      if (!bin) return fail("未检测到本地 Whisper 引擎。请在终端执行：安装 whisper.cpp 并设置 STUDYDESK_WHISPER（macOS 可执行 brew install whisper-cpp）");
      const modelName = ["base", "small"].includes(body.model) ? body.model : "";
      if (!modelName) return fail("未知模型：仅支持 base / small");
      const model = path.join(WHISPER_MODEL_DIR, WHISPER_MODELS[modelName].file);
      if (!existsSync(model)) return fail("模型未下载，请先在面板点「下载模型」");
      /* 客户端断开 → 杀掉当前子进程（ffmpeg 或 whisper），不能等 spawn 后才注册 */
      let curChild = null;
      res.on("close", () => { try { curChild?.kill("SIGKILL"); } catch {} });
      try {
        send({ type: "phase", phase: "转换音频格式（ffmpeg）…" });
        const wav = path.join(dir, "录音-16k.wav");
        await new Promise((resolve, reject) => {
          const ff = findFfmpeg();
          const p = spawn(ff, ["-y", "-i", audio, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", wav]);
          curChild = p;
          p.on("close", c => c === 0 ? resolve() : reject(new Error("ffmpeg 退出码 " + c)));
          p.on("error", reject);
        });
        if (res.destroyed) { try { fs.unlinkSync(wav); } catch {} return; }   /* 断开后不再起 whisper */
        send({ type: "phase", phase: "本地识别中（视长度需几分钟）…" });
        const outPrefix = path.join(dir, "转写-精确");
        const child = spawn(bin, ["-m", model, "-f", wav, "-l", "zh", "-otxt", "-of", outPrefix], { env: { ...process.env } });
        curChild = child;
        let tail = [];
        child.stderr.setEncoding("utf8");
        child.stderr.on("data", d => {
          for (const line of d.split("\n")) {
            const t = line.trim();
            if (/^\[\d{2}:\d{2}/.test(t)) { send({ type: "phase", phase: "识别中 " + t.slice(0, 22) + "…" }); tail = []; }
            else if (t) { tail.push(t); if (tail.length > 3) tail.shift(); }
          }
        });
        child.stdout.setEncoding("utf8");
        child.stdout.on("data", d => {
          for (const line of d.split("\n")) {
            const t = line.trim();
            if (/^\[\d{2}:\d{2}/.test(t)) send({ type: "phase", phase: "识别中 " + t.slice(0, 22) + "…" });
          }
        });
        const wavTmp = path.join(dir, "录音-16k.wav");
        const cleanWav = () => { try { fs.unlinkSync(wavTmp); } catch {} };
        child.on("error", e => { cleanWav(); fail("启动失败：" + e.message); });
        child.on("close", code => {
          const txt = outPrefix + ".txt";
          if (code !== 0 || !existsSync(txt)) return fail((tail.join(" | ") || `whisper 退出码 ${code}`));
          const text = fs.readFileSync(txt, "utf8").trim();
          send({ type: "done", text, file: txt });
          try { fs.unlinkSync(wav); } catch {}
          res.end();
        });
      } catch (e) { fail(String(e.message || e)); }
      return;
    }
    if (req.method === "POST" && p === "/api/open-in-wps") {
      const body = JSON.parse(await readBody(req) || "{}");
      const file = typeof body.path === "string" ? resolveStoredPath(body.path) : "";
      if (!path.isAbsolute(file) || !DOC_EXTS.has(path.extname(file).toLowerCase())) return json(res, 400, { error: "bad doc path" });
      if (!existsSync(file)) return json(res, 404, { error: "文件不存在" });
      const { execFile } = await import("node:child_process");
      openSystem(file, { app: "wpsoffice" }).then(() => json(res, 200, { ok: true }), () => json(res, 500, { error: "打开文档失败，请确认已安装并关联 Office/WPS" }));
      return;
    }
    if (p === '/api/recent-links') {
      try {
        if (req.method === 'GET') return json(res, 200, { ok: true, ...recentLinks.list(u.searchParams.get('platform') || '') });
        if (req.method === 'POST') return json(res, 200, { ok: true, ...recentLinks.add(JSON.parse(await readBody(req) || '{}')) });
        if (req.method === 'DELETE') return json(res, 200, { ok: true, ...recentLinks.remove(u.searchParams.get('key') || '') });
      } catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'POST' && p === '/api/recent-links/limit') {
      try { return json(res, 200, { ok: true, ...recentLinks.setLimit(JSON.parse(await readBody(req) || '{}').limit) }); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === 'GET' && p === '/api/bili-transcript/status') {
      const status = biliAsrStatus();
      return json(res, 200, { ok: true, ready: status.ready, engine: status.engine, label: status.label });
    }
    if (req.method === 'POST' && p === '/api/bili-transcript/start') {
      try { return json(res, 200, await startBiliTranscript(JSON.parse(await readBody(req) || '{}'))); }
      catch (error) { return json(res, 400, { error: error.message }); }
    }
    if (req.method === "GET" && p === "/api/bili-live/resolve") {
      try {
        const info = await resolveBili(u.searchParams.get("url") || "");
        const live = await getLivePlayUrl(info.bvid, info.cid);
        const mediaUrl = `/api/bili-live/media?u=${encodeURIComponent(live.url)}&s=${liveSig(live.url)}&sd_token=${SD_API_TOKEN}`;
        return json(res, 200, {
          ok: true, title: info.title, bvid: info.bvid, cid: info.cid,
          page: info.page, pagesCount: info.pagesCount, part: info.part,
          seek: info.seek, duration: info.duration, quality: live.quality, sizeMB: live.sizeMB, mediaUrl,
        });
      } catch (e) {
        /* 输入类错误（无 BV/链接非法）→ 400；上游故障 → 502 */
        const msg = e.message || String(e);
        const isClient = /BV 号|链接|格式/.test(msg);
        return json(res, isClient ? 400 : 502, { error: msg });
      }
    }
    if ((req.method === "GET" || req.method === "HEAD") && p === "/api/bili-live/media") {
      const target = u.searchParams.get("u") || "";
      /* 域名按后缀锚定匹配，防 evil-bilivideo.com / bilivideo.cdn.attacker.net 类子串绕过 */
      const hostOk = (() => { try { return /^https:\/\/([a-z0-9-]+\.)*(bilivideo\.(com|cn|net)|akamaized\.net)\//i.test(target); } catch { return false; } })();
      if (!hostOk) return json(res, 400, { error: "bad media url" });
      if (liveSig(target) !== u.searchParams.get("s")) return json(res, 403, { error: "bad signature" });
      return biliLiveMedia(req, res, target);
    }
    if (req.method === "POST" && p === "/api/bilibili") {
      const body = JSON.parse(await readBody(req) || "{}");
      return biliDownload(req, res, body);
    }
    if (req.method === "POST" && p === "/api/session-media/download") {
      const body = JSON.parse(await readBody(req) || "{}");
      const url = String(body.url || "").trim();
      if (!/^https?:\/\//i.test(url)) return json(res, 400, { error: "url 必须是 http(s)" });
      const { dir } = allocateSessionDir(DOWNLOAD_DIR);
      const cookieArgs = body.chromeCookies
        ? ["--cookies-from-browser", "chrome"]
        : (existsSync(COOKIE_FILE) ? ["--cookies", COOKIE_FILE] : []);
      return pipeSessionDownload(res, { url, dir, ytdlp: YTDLP, ffmpeg: findFfmpeg(), ua: UA, cookieArgs, spawn });
    }
    if (req.method === "POST" && p === "/api/session-media/discard") {
      const body = JSON.parse(await readBody(req) || "{}");
      try { return json(res, 200, discardSessionFile(DOWNLOAD_DIR, body.path)); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    if (req.method === "GET" && p === "/api/feishu-check") {
      const status = await feishuStatus();
      return json(res, 200, { ...status, downloadDir: FEISHU_DIR });
    }
    if (req.method === "POST" && p === "/api/feishu/resolve") {
      const body = JSON.parse(await readBody(req) || "{}");
      try {
        const info = parseFeishuUrl(body.url || "");
        const status = await feishuStatus();
        let title = "";
        if (status.loggedIn) {
          try { title = await feishuTitle(info); } catch {}
        }
        return json(res, 200, {
          ok: true, ...info, title,
          cli: status.cli, loggedIn: status.loggedIn,
          loginHint: status.loggedIn ? "" : (status.cli ? "下载需要先在终端执行：lark-cli auth login --domain docs,drive,minutes,wiki" : "下载需要本机安装 lark-cli 并登录飞书"),
        });
      } catch (e) {
        return json(res, 400, { error: e.message });
      }
    }
    if (req.method === "POST" && p === "/api/feishu/import") {
      const body = JSON.parse(await readBody(req) || "{}");
      return feishuImport(req, res, body);
    }
    if (req.method === "POST" && p === "/api/feishu/remove-local") {
      const body = JSON.parse(await readBody(req, 4096) || "{}");
      try { return json(res, 200, removeFeishuVideo(FEISHU_DIR, resolveStoredPath(body.path))); }
      catch (e) { return json(res, 400, { error: e.message }); }
    }
    json(res, 404, { error: "not found" });
  } catch (e) {
    if (!res.headersSent) {
      const code = e?.status || (e instanceof SyntaxError ? 400 : 500);   /* SyntaxError = 请求体不是合法 JSON */
      json(res, code, { error: String(e.message || e) });
    }
    else { try { res.destroy(); } catch {} }   /* 半写状态的连接直接回收，不滞留 */
  }
});

/* 个人工具稳定性兜底：单请求异常不打崩整个服务 */
process.on("uncaughtException", err => console.error("[uncaughtException]", err));
process.on("unhandledRejection", err => console.error("[unhandledRejection]", err));

// Binding errors must exit, so the launcher can retry a port race. The global
// request exception handler must not leave an unbound background process alive.
server.on("error", err => {
  console.error("[listen]", err.code, err.message);
  process.exit(err.code === "EADDRINUSE" ? 98 : 1);
});
server.listen(PORT, HOST, () => {
  console.log(`✅ 网课学习工作台已启动: ${PAGE_URL}`);
  console.log(`   视频目录: ${DEFAULT_DIR}`);
  console.log(`   yt-dlp: ${existsSync(YTDLP) ? "OK" : "缺失!"}   ffmpeg: ${findFfmpeg() || "缺失(B站合并需要)"}`);
  /* 豆包 APP 导出目录监听（~/Doubao/chats，15s 轮询） */
  doubaoWatchKick();
  /* 已配置的 MCP 服务自动重连（逐个串行，失败不影响启动） */
  const names = mcpReadConfig().servers.map(s => s.name);
  (async () => {
    for (const name of names) {
      const r = await mcpConnect(name);
      console.log(`   MCP「${name}」: ${r.ok ? `已连接（${r.tools.length} 个工具）` : "连接失败：" + r.error}`);
    }
  })();
});
