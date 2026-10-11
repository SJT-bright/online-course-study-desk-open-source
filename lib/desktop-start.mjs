import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { setTimeout as delay } from 'node:timers/promises';
import { portOwners, isDeskProcess } from './desktop-process.mjs';

const root = fs.realpathSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..'));
const preferred = Number(process.env.STUDYDESK_PORT || 8790);
const home = path.resolve(process.env.STUDYDESK_HOME || os.homedir());
const logs = process.platform === 'darwin' ? path.join(home, 'Library/Logs/StudyDesk') : path.join(home, '.study-desk/logs');
const logFile = path.join(logs, 'server.log');
const stateDir = path.join(home, '.study-desk');
const rootID = createHash('sha256').update(root).digest('hex').slice(0, 16);
const stateFile = path.join(stateDir, `desktop-service-${rootID}.json`);
const validPort = port => Number.isInteger(port) && port >= 1024 && port <= 65535;
const urlFor = port => `http://127.0.0.1:${port}/`;

async function probe(port) {
  const owners = portOwners(port);
  if (!owners.length) return { free: true };
  if (!owners.every(pid => isDeskProcess(pid, root))) return { foreign: true };
  try {
    if (process.platform === 'win32') {
      const token = fs.readFileSync(path.join(stateDir, 'shell.token'), 'utf8').trim();
      const response = await fetch(new URL('/_studydesk/health', urlFor(port)), { headers: { 'x-studydesk-shell': token }, signal: AbortSignal.timeout(1200) });
      const identity = await response.json();
      if (response.ok && identity.app === 'study-desk' && identity.root === root && identity.home === home && owners.includes(identity.pid)) return { ready: true, pid: identity.pid };
      return { foreign: true };
    }
    const r = await fetch(urlFor(port), { signal: AbortSignal.timeout(1200), redirect: 'error' });
    const html = await r.text();
    if (r.ok && html.includes('const __SD_TOKEN = ') && /const VER = "[\d.]+";/.test(html)) {
      const current = portOwners(port);
      if (current.length && current.every(pid => owners.includes(pid) && isDeskProcess(pid, root)))
        return { ready: true, pid: current[0] };
    }
  } catch {}
  return { starting: true };
}

function saveState(port, pid, reused) {
  const result = { reused, pid, port, url: urlFor(port) };
  const temp = stateFile + '.' + process.pid;
  try {
    fs.writeFileSync(temp, JSON.stringify({ root, home, ...result }), { mode: 0o600 });
    fs.renameSync(temp, stateFile);
  } finally { fs.rmSync(temp, { force: true }); }
  return result;
}

async function freePort() {
  const reserve = net.createServer();
  await new Promise((resolve, reject) => { reserve.once('error', reject); reserve.listen(0, '127.0.0.1', resolve); });
  const port = reserve.address().port;
  await new Promise(resolve => reserve.close(resolve));
  return port;
}

async function waitExisting(port) {
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    const state = await probe(port);
    if (state.ready) return saveState(port, state.pid, true);
    if (!state.starting) return null;
    await delay(150);
  }
  throw new Error(`本地服务已占用端口 ${port}，但尚未准备好；请查看启动日志后重试。`);
}

async function main() {
  if (!validPort(preferred)) throw new Error('本机端口无效，请使用 1024–65535。');
  fs.mkdirSync(logs, { recursive: true });
  fs.mkdirSync(stateDir, { recursive: true });
  let DatabaseSync;
  try { ({ DatabaseSync } = await import('node:sqlite')); }
  catch { throw new Error('启动需要 Node.js 22.5 或更新版本，请升级后重试。'); }
  const guard = new DatabaseSync(path.join(stateDir, 'desktop-start.sqlite'));
  guard.exec('PRAGMA busy_timeout = 25000');
  let locked = false;
  try {
    guard.exec('BEGIN IMMEDIATE'); locked = true;
    let saved;
    try { saved = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch {}
    const candidates = [...new Set([
      ...(saved?.root === root && saved?.home === home && validPort(saved.port) ? [saved.port] : []), preferred,
    ])];
    let port;
    for (const candidate of candidates) {
      const state = await probe(candidate);
      if (state.ready) return saveState(candidate, state.pid, true);
      if (state.starting) {
        const ready = await waitExisting(candidate);
        if (ready) return ready;
      }
      if (!state.foreign) { port = candidate; break; }
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      port ??= await freePort();
      const log = fs.openSync(logFile, 'a');
      let child;
      try {
        child = spawn(process.execPath, [path.join(root, 'server.mjs')], {
          cwd: root, detached: true, windowsHide: true, stdio: ['ignore', log, log],
          env: { ...process.env, STUDYDESK_HOME: home, STUDYDESK_PORT: String(port) },
        });
      } finally { fs.closeSync(log); }
      let launchError;
      child.on('error', error => { launchError = error; }); child.unref();
      const deadline = Date.now() + 20000;
      let conflict = false;
      let accepted = false;
      try {
        while (Date.now() < deadline) {
          if (launchError) throw launchError;
          const state = await probe(port);
          if (state.ready) { accepted = state.pid === child.pid; return saveState(port, state.pid, !accepted); }
          if (state.foreign || child.exitCode === 98) { conflict = true; break; }
          if (child.exitCode !== null) throw new Error(`服务启动失败（退出码 ${child.exitCode}），请查看启动日志。`);
          await delay(150);
        }
        if (!conflict) throw new Error('服务启动超过 20 秒，请查看启动日志后重试。');
      } finally {
        // Never terminate another port owner. Only this launch's child is eligible.
        if (!accepted && child.exitCode === null) child.kill('SIGTERM');
      }
      port = undefined;
    }
    throw new Error('多次尝试仍无法分配本机端口，请查看启动日志后重试。');
  } finally {
    if (locked) guard.exec('ROLLBACK');
    guard.close();
  }
}

try { console.log(JSON.stringify({ ok: true, ...await main() })); }
catch (e) { console.error(JSON.stringify({ ok: false, error: e.message, log: logFile })); process.exitCode = 1; }
