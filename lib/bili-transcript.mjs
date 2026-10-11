import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { toolEnv } from './platform.mjs';
import { findFfmpeg } from './whisper-file.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
export function biliAsrStatus() {
  const base = process.env.STUDYDESK_NANO_HOME || path.join(os.homedir(), 'phone-asr-selfhosted');
  const models = path.join(base, 'local/models/modelscope/models');
  const python = process.env.STUDYDESK_NANO_PYTHON || path.join(base, process.platform === 'win32' ? 'venv/Scripts/python.exe' : 'venv/bin/python');
  const model = process.env.STUDYDESK_NANO_MODEL || path.join(models, 'FunAudioLLM--Fun-ASR-Nano-2512/snapshots/master');
  const vad = process.env.STUDYDESK_NANO_VAD || path.join(models, 'iic--speech_fsmn_vad_zh-cn-16k-common-pytorch/snapshots/master');
  return { ready: [python, path.join(model, 'model.pt'), path.join(model, 'Qwen3-0.6B/config.json'), path.join(vad, 'model.pt')].every(p => fs.existsSync(p)) && !!findFfmpeg(),
    engine: 'fun-asr-nano', label: 'Fun-ASR-Nano（Qwen3 底座）', python, model, vad };
}

function run(command, args, { onLine, stdin, timeoutMs = 3600000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'], env: toolEnv(), windowsHide: true });
    let tail = '', buffer = '', settled = false;
    const timer = setTimeout(() => { child.kill('SIGTERM'); finish(new Error('本地转写处理超时，可重试')); }, timeoutMs);
    const finish = error => {
      if (settled) return;
      settled = true; clearTimeout(timer);
      if (error) reject(error); else resolve();
    };
    child.stderr.setEncoding('utf8'); child.stderr.on('data', s => { tail = (tail + s).slice(-2000); });
    child.stdout.setEncoding('utf8'); child.stdout.on('data', s => {
      buffer += s;
      let end;
      while ((end = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let event; try { event = JSON.parse(line); } catch { continue; }
        if (onLine) { try { onLine(event); } catch (error) { child.kill('SIGTERM'); finish(error); } }
      }
    });
    child.on('error', finish);
    child.on('close', code => finish(code === 0 ? null : new Error(tail.trim() || '本地识别进程退出：' + code)));
    if (stdin) child.stdin.end(JSON.stringify(stdin) + '\n'); else child.stdin.end();
  });
}

export function fullDurationSec(info) {
  const durationSec = Math.floor(Number(info?.duration));
  if (!Number.isFinite(durationSec) || durationSec <= 0 || durationSec > 86400) throw new Error('未取得视频时长');
  return durationSec;
}

export async function transcribeBiliAudio({ dir, mediaUrl, durationSec, onUpdate }) {
  const status = biliAsrStatus();
  if (!status.ready) throw new Error('未找到本地 Fun-ASR-Nano 模型或运行环境；请检查本机模型部署');
  fs.mkdirSync(dir, { recursive: true });
  const result = path.join(dir, 'result.json');
  try {
    const cached = JSON.parse(fs.readFileSync(result, 'utf8'));
    if (cached.done && cached.durationSec === durationSec && cached.lines?.length) {
      onUpdate({ type: 'chunk', processedSec: durationSec, lines: cached.lines });
      return cached;
    }
  } catch {}
  const ffmpeg = findFfmpeg(), audio = path.join(dir, 'audio.wav');
  const timeoutMs = Math.min(12 * 3600 * 1000, Math.max(2 * 3600 * 1000, Math.ceil(Number(durationSec) * 3000)));
  // The extraction is committed only after ffmpeg succeeds; failed downloads never become a cache hit.
  // A shorter wav (for example a previous 30-minute extract) is not a full-length cache.
  if (fs.existsSync(audio) && fs.statSync(audio).size < durationSec * 32000 * 0.95) fs.rmSync(audio, { force: true });
  if (!fs.existsSync(audio)) {
    onUpdate({ type: 'phase', phase: '正在提取独立音轨，播放可继续…' });
    const tmp = path.join(dir, 'audio.part.wav');
    try {
      await run(ffmpeg, ['-nostdin', '-hide_banner', '-loglevel', 'error', '-y',
        '-user_agent', 'Mozilla/5.0', '-referer', 'https://www.bilibili.com/',
        '-i', mediaUrl, '-t', String(durationSec), '-map', '0:a:0', '-vn', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', tmp], { timeoutMs });
      fs.renameSync(tmp, audio);
    } catch (error) { fs.rmSync(tmp, { force: true }); throw error; }
  }
  await run(status.python, [path.join(root, 'bili-asr-worker.py')], {
    stdin: { audio, result, durationSec, ffmpeg, model: status.model, vad: status.vad },
    onLine: event => onUpdate(event),
    timeoutMs,
  });
  const payload = JSON.parse(fs.readFileSync(result, 'utf8'));
  if (!payload.done || !payload.lines?.length) throw new Error('音频转写未完成，请重试');
  return payload;
}
