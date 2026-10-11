import fs from 'node:fs';
import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const LOCAL_ASR_FILES = {
  'encoder.int8.onnx': { min: 150_000_000, sha256: '81a70226a8934e6ed92aa1d4fc486b428b5398e2f2619ed4897b7294cab90e9a' },
  'decoder.int8.onnx': { min: 65_000_000, sha256: 'f3cca9f77bb9d93c8fcbfb63ae617b6b1ee96818df3aa3b151c40658fe38594f' },
  'tokens.txt': { min: 50_000, sha256: '59aba8873a2ed1e122c25fee421e25f283b63290efbde85c1f01a853d83cb6e6' },
};
export const LOCAL_ASR_MODEL = 'csukuangfj/sherpa-onnx-streaming-paraformer-bilingual-zh-en';
export const LOCAL_ASR_REVISION = '8e40c43232a1c5c66c82111efc5820d3accca11b';
export const localAsrRuntimeReady = () => fs.existsSync(path.join(root, 'local-asr/node_modules/sherpa-onnx-node/package.json'));
export function localAsrModelReady(modelDir) {
  return Object.entries(LOCAL_ASR_FILES).every(([name, meta]) => {
    try { return fs.statSync(path.join(modelDir, name)).size >= meta.min; } catch { return false; }
  });
}

export function startLocalAsr(modelDir, onEvent) {
  if (!localAsrRuntimeReady()) throw new Error('本机识别引擎未安装');
  if (!localAsrModelReady(modelDir)) throw new Error('本机识别模型未下载');
  const worker = fork(path.join(root, 'lib/local-asr-worker.cjs'), [modelDir], {
    cwd: root, execArgv: [], stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  });
  let finished = false, ready = false, pendingBytes = 0;
  let settle;
  const started = new Promise((resolve, reject) => { settle = { resolve, reject }; });
  const timer = setTimeout(() => { if (!ready) { settle.reject(new Error('本机识别模型启动超时')); worker.kill(); } }, 30000);
  const errors = [];
  worker.stderr.on('data', data => { errors.push(String(data).slice(-500)); if (errors.length > 4) errors.shift(); });
  worker.on('message', event => {
    if (event.type === 'ready') { ready = true; clearTimeout(timer); settle.resolve(); }
    else if (event.type === 'done') { finished = true; onEvent(event); worker.disconnect(); }
    else if (event.type === 'error') { finished = true; onEvent(event); worker.disconnect(); }
    else onEvent(event);
  });
  worker.on('error', error => { if (!ready) { clearTimeout(timer); settle.reject(error); } else onEvent({ type: 'error', message: error.message }); });
  worker.on('exit', code => {
    clearTimeout(timer);
    if (!ready) settle.reject(new Error('本机识别引擎启动失败：' + errors.join(' ').slice(-300)));
    else if (!finished) onEvent({ type: 'error', message: '本机识别进程意外退出（' + code + '）' });
  });
  return {
    started,
    feed(pcm) {
      if (!ready || finished || pendingBytes > 3_000_000) return false;
      pendingBytes += pcm.length;
      worker.send({ type: 'audio', pcm: pcm.toString('base64') }, error => {
        pendingBytes -= pcm.length;
        if (error && !finished) onEvent({ type: 'error', message: error.message });
      });
      return true;
    },
    stop() { if (ready && !finished) worker.send({ type: 'stop' }); },
    kill() { if (!finished) worker.kill(); },
  };
}
