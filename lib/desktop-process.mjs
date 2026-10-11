import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

// Finder starts apps in the C locale; lsof then escapes UTF-8 path bytes.
export function decodeLsofPath(value) {
  return value.replace(/(?:\\x[0-9a-f]{2})+/gi, part =>
    Buffer.from(part.replace(/\\x/gi, ''), 'hex').toString('utf8'));
}

export function portOwners(port) {
  try {
    if (process.platform === 'win32') {
      const wanted = port === '*' ? '' : `| Where-Object LocalPort -eq ${Number(port)}`;
      const out = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue ${wanted} | Select-Object -ExpandProperty OwningProcess -Unique`], { encoding: 'utf8', windowsHide: true });
      return out.trim().split(/\s+/).filter(Boolean).map(Number);
    }
    const selector = port === '*' ? '-iTCP' : `-iTCP:${port}`;
    return [...new Set(execFileSync('/usr/sbin/lsof', ['-nP', selector, '-sTCP:LISTEN', '-t'],
      { encoding: 'utf8' }).trim().split(/\s+/).filter(Boolean).map(Number))];
  } catch (e) { if (e.status === 1) return []; throw e; }
}

export function isDeskProcess(pid, root) {
  try {
    if (process.platform === 'win32') {
      const command = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `(Get-CimInstance Win32_Process -Filter "ProcessId=${Number(pid)}").CommandLine`], { encoding: 'utf8', windowsHide: true });
      return command.toLowerCase().includes(path.join(fs.realpathSync(root), 'server.mjs').toLowerCase());
    }
    const cwd = execFileSync('/usr/sbin/lsof', ['-a', '-p', String(pid), '-d', 'cwd', '-Fn'],
      { encoding: 'utf8' }).split('\n').find(line => line.startsWith('n'))?.slice(1);
    const command = execFileSync('/bin/ps', ['-p', String(pid), '-o', 'command='], { encoding: 'utf8' });
    return cwd !== undefined && fs.realpathSync(decodeLsofPath(cwd)) === fs.realpathSync(root)
      && /\bnode\s+.*?\bserver\.mjs(?=\s|$)/.test(command);
  } catch { return false; }
}

export function deskServicePids(root) {
  return portOwners('*').filter(pid => isDeskProcess(pid, root));
}
