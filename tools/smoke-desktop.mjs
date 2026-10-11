import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { once } from 'node:events';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const data = fs.mkdtempSync(path.join(os.tmpdir(), 'studydesk-桌面-'));
const resultFile = path.join(data, 'result.json');
const busy = http.createServer((q,r) => r.end('foreign-owner')); busy.listen(0, '127.0.0.1'); await once(busy,'listening');
const port = busy.address().port;
let service;
try {
  const executable = process.argv[2] || require('electron');
  const args = process.argv[2] ? [] : ['.'];
  const child = spawn(executable, args, { env: { ...process.env, STUDYDESK_NODE: process.execPath, STUDYDESK_DESKTOP_DATA: data, STUDYDESK_SMOKE: '1', STUDYDESK_SMOKE_RESULT: resultFile, STUDYDESK_PORT: String(port), STUDYDESK_MEDIA: path.join(data,'media') }, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 120000);
  const [code] = await once(child, 'exit'); clearTimeout(timer);
  const result = JSON.parse(fs.readFileSync(resultFile,'utf8')); service = result.service;
  if (code !== 0 || !result.ok) throw new Error(result.error || `Desktop exit ${code}`);
  if (result.service.port === port) throw new Error('occupied port not handled');
  if (await (await fetch(`http://127.0.0.1:${port}/`)).text() !== 'foreign-owner') throw new Error('foreign process disturbed');
  const health = await fetch(new URL('/_studydesk/health', service.url));
  if (health.status !== 403) throw new Error('service identity exposed');
  // A second process uses the same Chromium profile and SQLite service; server port may change.
  fs.writeFileSync(path.join(data,'verified-smoke.json'), JSON.stringify(result,null,2));
  if (process.env.STUDYDESK_SMOKE_REPORT) fs.copyFileSync(path.join(data,'verified-smoke.json'), process.env.STUDYDESK_SMOKE_REPORT);
  console.log(JSON.stringify({ ...result, foreignOwnerPreserved: true, unauthenticatedHealthBlocked: true }));
} finally {
  if (!service) try { service = JSON.parse(fs.readFileSync(resultFile,'utf8')).service; } catch {}
  if (!service && fs.existsSync(path.join(data,'home/.study-desk'))) {
    for (const name of fs.readdirSync(path.join(data,'home/.study-desk'), { withFileTypes: true })) {
      if (name.name.startsWith('desktop-service-')) try { service = JSON.parse(fs.readFileSync(path.join(data,'home/.study-desk',name.name),'utf8')); } catch {}
    }
  }
  if (service?.pid) try { process.kill(service.pid); } catch {}
  await new Promise(r => busy.close(r));
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
