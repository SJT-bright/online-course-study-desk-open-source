import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';

export function toolPath(names, { envName, platform = process.platform, env = process.env } = {}) {
  if (envName && env[envName] && fs.existsSync(env[envName])) return env[envName];
  const dirs = [env.STUDYDESK_BIN, ...(env.PATH || '').split(platform === 'win32' ? ';' : ':'),
    ...(platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin', '/opt/homebrew/opt/whisper-cpp/bin'] : [])].filter(Boolean);
  for (const dir of dirs) for (const name of names) {
    const p = path.join(dir, name + (platform === 'win32' && !name.endsWith('.exe') ? '.exe' : ''));
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}
export function toolEnv() {
  const extra = [process.env.STUDYDESK_BIN, ...(process.platform === 'darwin' ? ['/opt/homebrew/bin', '/usr/local/bin'] : [])].filter(Boolean);
  return { ...process.env, PATH: [...extra, process.env.PATH || ''].join(path.delimiter) };
}
export function openSystem(target, { app } = {}) {
  const command = process.platform === 'win32' ? 'explorer.exe' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const args = process.platform === 'darwin' && app ? ['-a', app, target].filter(Boolean) : [target];
  return new Promise((resolve, reject) => execFile(command, args, { windowsHide: true }, error => {
    // Explorer may exit 1 even after handing off to the shell.
    if (error && !(process.platform === 'win32' && error.code === 1)) reject(error); else resolve();
  }));
}
