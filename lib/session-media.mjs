import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";

const VIDEO_EXT = new Set([".mp4", ".mkv", ".webm"]);

function startsWithDotDot(value) {
  return value === ".." || value.startsWith("../") || value.startsWith("..\\");
}

/* 空相对路径表示目标就是根目录本身，也不算「目录之内」。 */
function outsideOrSelf(root, target) {
  const rel = path.relative(root, target);
  return !rel || rel === ".." || rel.startsWith(`..${path.sep}`) || path.isAbsolute(rel);
}

function toolReady(bin) {
  if (typeof bin !== "string" || !bin.trim()) return false;
  try { return fs.statSync(bin).isFile(); } catch { return false; }
}

function realInside(root, file) {
  if (!root || !file) return null;
  try {
    const candidate = path.isAbsolute(file) ? path.resolve(file) : path.resolve(root, file);
    if (!fs.existsSync(candidate) || !fs.statSync(candidate).isFile()) return null;
    const realRoot = fs.realpathSync(root);
    const realFile = fs.realpathSync(candidate);
    if (outsideOrSelf(realRoot, realFile) || !fs.statSync(realFile).isFile()) return null;
    return realFile;
  } catch { return null; }
}

function newestVideo(dir) {
  try {
    let best = null;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isFile()) continue;
      if (!VIDEO_EXT.has(path.extname(entry.name).toLowerCase())) continue;
      const full = path.join(dir, entry.name);
      let mtimeMs = 0;
      try { mtimeMs = fs.statSync(full).mtimeMs; } catch { continue; }
      if (!best || mtimeMs > best.mtimeMs || (mtimeMs === best.mtimeMs && entry.name > best.name)) {
        best = { full, name: entry.name, mtimeMs };
      }
    }
    return best ? realInside(dir, best.full) : null;
  } catch { return null; }
}

export function allocateSessionDir(downloadDir) {
  const id = crypto.randomUUID();
  const dir = path.join(downloadDir, "session", id);
  fs.mkdirSync(dir, { recursive: true });
  return { id, dir };
}

export function discardSessionFile(downloadDir, filePath) {
  if (typeof filePath !== "string" || !filePath || filePath.includes("\0")) {
    throw new Error("只能删除本次临时下载");
  }
  if (!path.isAbsolute(filePath) && (startsWithDotDot(filePath) || startsWithDotDot(path.normalize(filePath)))) {
    throw new Error("只能删除本次临时下载");
  }
  const sessionRoot = path.resolve(path.join(downloadDir, "session"));
  const candidate = path.isAbsolute(filePath) ? path.resolve(filePath) : path.resolve(downloadDir, filePath);
  if (outsideOrSelf(sessionRoot, candidate)) throw new Error("只能删除本次临时下载");
  if (!fs.existsSync(candidate)) throw new Error("临时视频已经不在");

  let listed;
  try { listed = fs.lstatSync(candidate); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("临时视频已经不在");
    throw new Error("只能删除本次临时下载");
  }
  if (!listed.isFile()) throw new Error("只能删除本次临时下载");

  let realFile;
  let realRoot;
  try {
    realFile = fs.realpathSync(candidate);
    realRoot = fs.realpathSync(sessionRoot);
  } catch (error) {
    if (error?.code === "ENOENT") throw new Error("临时视频已经不在");
    throw new Error("只能删除本次临时下载");
  }
  if (outsideOrSelf(realRoot, realFile)) throw new Error("只能删除本次临时下载");
  let realStat;
  try { realStat = fs.statSync(realFile); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("临时视频已经不在");
    throw new Error("只能删除本次临时下载");
  }
  if (!realStat.isFile()) throw new Error("只能删除本次临时下载");

  try { fs.unlinkSync(candidate); }
  catch (error) {
    if (error?.code === "ENOENT") throw new Error("临时视频已经不在");
    throw error;
  }

  let current = path.dirname(realFile);
  while (current && current !== realRoot && !outsideOrSelf(realRoot, current)) {
    let names;
    try { names = fs.readdirSync(current); } catch { break; }
    if (names.length) break;
    const parent = path.dirname(current);
    fs.rmdirSync(current);
    if (!parent || parent === current) break;
    current = parent;
  }
  return { ok: true, deleted: realFile };
}

function killChild(child) {
  const pid = child?.pid;
  if (typeof pid !== "number" || pid <= 1) {
    try { child?.kill?.("SIGKILL"); } catch { /* 进程已经退出 */ }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try { child.kill("SIGKILL"); } catch { /* 进程已经退出 */ }
  }
}

export function pipeSessionDownload(res, options) {
  let responseEnded = false;
  const send = obj => {
    try {
      if (!res || res.destroyed || res.writableEnded || responseEnded) return;
      res.write(`data: ${JSON.stringify(obj)}\n\n`);
    } catch { /* 客户端已断开 */ }
  };
  const endResponse = () => {
    if (responseEnded || res?.writableEnded) return;
    responseEnded = true;
    try { res.end(); } catch { /* 响应已结束 */ }
  };
  const fail = message => {
    send({ type: "error", message: String(message || "临时下载失败") });
    endResponse();
  };

  try {
    if (!res || typeof res.writeHead !== "function" || typeof res.end !== "function") return;
    try {
      if (!res.headersSent) {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-store",
          Connection: "keep-alive",
        });
      }
    } catch (error) {
      fail(error?.message || error);
      return;
    }

    const { url, dir, ytdlp, ffmpeg, ua, cookieArgs, spawn } = options || {};
    const target = String(url ?? "").trim();
    if (!/^https?:\/\//i.test(target)) return fail("只能下载 http(s) 链接");
    if (!toolReady(ytdlp)) return fail("缺少 yt-dlp，无法临时下载");
    if (!toolReady(ffmpeg)) return fail("缺少 ffmpeg，无法合并音视频");
    if (typeof dir !== "string" || !dir) return fail("缺少临时下载目录");
    if (typeof spawn !== "function") return fail("无法启动下载");
    fs.mkdirSync(dir, { recursive: true });

    const args = [
      "--no-playlist", "--newline", "--no-mtime",
      "--add-headers", `User-Agent: ${ua ?? ""}`,
      "--add-headers", "Referer: https://www.bilibili.com/",
      "--ffmpeg-location", ffmpeg,
      "-P", dir,
      "-o", "lesson.%(ext)s",
      "--merge-output-format", "mp4",
      "-f", "bv*[vcodec^=avc1][height<=720]+ba[acodec^=mp4a]/bv*[height<=720]+ba/b",
      "--print", "after_move:filepath", "--no-simulate",
      ...(Array.isArray(cookieArgs) ? cookieArgs : []),
      target,
    ];

    let child;
    try { child = spawn(ytdlp, args, { detached: true }); }
    catch (error) { return fail(error?.message || error); }
    if (!child || typeof child.on !== "function") return fail("无法启动下载");

    let finished = false;
    let outBuf = "";
    let errBuf = "";
    const printed = [];
    const errTail = [];
    const rememberErr = line => {
      const text = String(line || "").trim();
      if (!text) return;
      errTail.push(text);
      if (errTail.length > 15) errTail.shift();
    };
    const consumeOut = line => {
      const text = String(line || "").trim();
      if (!text) return;
      const pct = text.match(/\[download\]\s+([\d.]+)%/);
      if (pct) {
        send({ type: "progress", pct: parseFloat(pct[1]) });
        if (text.startsWith("[download] 100%")) send({ type: "phase", phase: "收尾中…" });
        return;
      }
      if (text.startsWith("[Merger]") || text.startsWith("[ExtractAudio]")) {
        send({ type: "phase", phase: "合并音视频…" });
        return;
      }
      if (!text.startsWith("[")) { printed.push(text); return; }
      if (/ERROR|error/i.test(text)) {
        rememberErr(text);
        send({ type: "log", line: text.slice(0, 300) });
      }
    };
    const pushChunk = (chunk, getBuf, setBuf, pushLine) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk);
      const parts = (getBuf() + text).split("\n");
      setBuf(parts.pop() ?? "");
      for (const part of parts) pushLine(part);
    };

    const stop = () => {
      if (finished) return;
      finished = true;
      killChild(child);
      send({ type: "cancelled" });
      endResponse();
    };
    res.on?.("close", stop);

    child.stdout?.setEncoding?.("utf8");
    child.stdout?.on?.("data", chunk => pushChunk(chunk, () => outBuf, value => { outBuf = value; }, consumeOut));
    child.stderr?.setEncoding?.("utf8");
    child.stderr?.on?.("data", chunk => pushChunk(chunk, () => errBuf, value => { errBuf = value; }, rememberErr));
    child.on("error", error => {
      if (finished) return;
      finished = true;
      fail(error?.message || error);
    });
    child.on("close", code => {
      if (finished) return;
      finished = true;
      try {
        if (outBuf) consumeOut(outBuf);
        if (errBuf) rememberErr(errBuf);
        outBuf = "";
        errBuf = "";
        let picked = null;
        for (let i = printed.length - 1; i >= 0; i--) {
          picked = realInside(dir, printed[i]);
          if (picked) break;
        }
        if (!picked) picked = newestVideo(dir);
        if (code === 0 && picked) send({ type: "done", path: picked, name: path.basename(picked) });
        else {
          const msg = errTail.slice(-4).join(" | ") || `yt-dlp 退出码 ${code}`;
          const friendly = /412/.test(msg)
            ? "B站临时风控(412)：请等几分钟重试；或先在 Chrome 登录 B站，再勾选「使用 Chrome 的 B站登录态」后重新下载"
            : msg;
          send({ type: "error", message: friendly });
        }
      } catch (error) {
        send({ type: "error", message: error?.message || String(error) });
      }
      endResponse();
    });
  } catch (error) {
    fail(error?.message || error);
  }
}
