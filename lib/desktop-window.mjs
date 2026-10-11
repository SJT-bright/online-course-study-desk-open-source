import fs from 'node:fs';
import { createHash } from 'node:crypto';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';

export function uiSocketPath(home = os.homedir(), platform = process.platform) {
  if (platform === 'win32') return '\\\\.\\pipe\\studydesk-ui-' + createHash('sha256').update(path.resolve(home)).digest('hex').slice(0, 24);
  return path.join(home, '.study-desk', 'ui.sock');
}

/** Ask the running local app to open a window. Never launches a browser. */
export function openLocalWindow(url, home = os.homedir()) {
  const target = String(url || '').trim();
  if (!/^https?:\/\//i.test(target)) return Promise.reject(new Error('无效链接'));
  const sock = uiSocketPath(home);
  if (process.platform !== 'win32' && !fs.existsSync(sock)) return Promise.reject(new Error('本地应用窗口未就绪'));
  return new Promise((resolve, reject) => {
    const client = net.connect(sock);
    const timer = setTimeout(() => {
      client.destroy();
      reject(new Error('本地应用没有响应'));
    }, 2000);
    const done = (error) => {
      clearTimeout(timer);
      if (error) reject(error);
      else resolve({ ok: true, mode: 'app' });
    };
    let settled = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      done(error);
    };
    client.on('connect', () => client.end(JSON.stringify({ url: target }) + '\n'));
    client.on('error', (error) => finish(error.code === 'ENOENT' ? new Error('本地应用窗口未就绪') : error));
    client.on('close', (hadError) => { if (!hadError) finish(); });
  });
}
