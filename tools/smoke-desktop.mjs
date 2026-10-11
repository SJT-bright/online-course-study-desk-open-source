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
async function occupy(port = 0) {
  const server = http.createServer((q,r) => r.end('foreign-owner'));
  server.listen(port,'127.0.0.1'); await once(server,'listening'); return server;
}
const busy = await occupy(); const port = busy.address().port;
let service, fallbackOwner;
async function run(expected = '') {
  fs.rmSync(resultFile,{force:true});
  const executable = process.argv[2] || require('electron');
  const child = spawn(executable, process.argv[2] ? [] : ['.'], { env: { ...process.env, STUDYDESK_NODE: process.execPath, STUDYDESK_DESKTOP_DATA: data, STUDYDESK_SMOKE: '1', STUDYDESK_SMOKE_EXPECT: expected, STUDYDESK_SMOKE_RESULT: resultFile, STUDYDESK_PORT: String(port), STUDYDESK_MEDIA: path.join(data,'media') }, stdio: 'inherit', windowsHide: true });
  const timer = setTimeout(() => child.kill(), 150000);
  const [code] = await once(child,'exit'); clearTimeout(timer);
  const result = JSON.parse(fs.readFileSync(resultFile,'utf8')); service = result.service;
  if (code !== 0 || !result.ok) throw new Error(result.error || `Desktop exit ${code}`);
  return result;
}
try {
  const first = await run();
  if (first.service.port === port) throw new Error('occupied port not handled');
  const health = await fetch(new URL('/_studydesk/health', service.url));
  if (health.status !== 403) throw new Error('service identity exposed');
  // Stop only this isolated launch, then occupy its fallback port as well.
  process.kill(service.pid); service = undefined;
  await new Promise(r => setTimeout(r, 1500));
  fallbackOwner = await occupy(first.service.port);
  const second = await run(first.localStorage);
  if (second.service.port === first.service.port || !second.persistedAcrossRestart) throw new Error('port change not exercised');
  if (await (await fetch(`http://127.0.0.1:${port}/`)).text() !== 'foreign-owner') throw new Error('foreign process disturbed');
  if (await (await fetch(first.service.url)).text() !== 'foreign-owner') throw new Error('fallback owner disturbed');
  const result = { ...second, previousPort: first.service.port, foreignOwnerPreserved: true, unauthenticatedHealthBlocked: true, storageAfterPortChange: true };
  if (process.env.STUDYDESK_SMOKE_REPORT) fs.writeFileSync(process.env.STUDYDESK_SMOKE_REPORT, JSON.stringify(result,null,2));
  console.log(JSON.stringify(result));
} finally {
  if (!service && fs.existsSync(path.join(data,'home/.study-desk'))) for (const item of fs.readdirSync(path.join(data,'home/.study-desk'))) {
    if (item.startsWith('desktop-service-')) try { service = JSON.parse(fs.readFileSync(path.join(data,'home/.study-desk',item),'utf8')); } catch {}
  }
  if (service?.pid) try { process.kill(service.pid); } catch {}
  if (fallbackOwner) await new Promise(r => fallbackOwner.close(r));
  await new Promise(r => busy.close(r));
  await new Promise(r => setTimeout(r, 500));
  fs.rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
}
