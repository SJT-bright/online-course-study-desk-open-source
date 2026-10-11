import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { once } from 'node:events';
import { decodeLsofPath, isDeskProcess, deskServicePids } from '../lib/desktop-process.mjs';

const exec = promisify(execFile);
const helper = new URL('../lib/desktop-start.mjs', import.meta.url);
async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-中文启动-'));
  fs.mkdirSync(path.join(root, 'lib'));
  fs.copyFileSync(helper, path.join(root, 'lib/desktop-start.mjs'));
  fs.copyFileSync(new URL('../lib/desktop-process.mjs', import.meta.url), path.join(root, 'lib/desktop-process.mjs'));
  const reserve = http.createServer(); reserve.listen(0, '127.0.0.1'); await once(reserve, 'listening');
  const port = reserve.address().port; await new Promise(r => reserve.close(r));
  const env = { ...process.env, LC_ALL: 'C', LANG: 'C', STUDYDESK_PORT: String(port), STUDYDESK_HOME: path.join(root, 'home') };
  const run = async () => JSON.parse((await exec(process.execPath, ['lib/desktop-start.mjs'], { cwd: root, env, timeout: 25000 })).stdout.trim());
  return { root, port, env, run, url: `http://127.0.0.1:${port}/` };
}
const stub = `import http from 'node:http'; import fs from 'node:fs';
fs.appendFileSync(process.env.STUDYDESK_HOME + '/starts', 'start\\n');
http.createServer((req,res)=>res.end('const __SD_TOKEN = "stub"; const VER = "1.0";')).listen(+process.env.STUDYDESK_PORT, '127.0.0.1');`;

test('cold and simultaneous launches share one detached service; warm launch reuses it', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const pids = new Set();
  try {
    fs.writeFileSync(path.join(f.root, 'server.mjs'), stub);
    const launched = await Promise.all([f.run(), f.run()]);
    launched.forEach(r => { if (r.pid) pids.add(r.pid); });
    assert.equal(launched.filter(r=>!r.reused).length, 1);
    assert.equal(launched.filter(r=>r.reused).length, 1);
    assert.equal(fs.readFileSync(path.join(f.env.STUDYDESK_HOME, 'starts'), 'utf8'), 'start\n');
    assert.equal((await fetch(f.url)).status, 200, 'service remains after helper exits');
    assert.equal((await f.run()).reused, true);
  } finally {
    for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch {}
    fs.rmSync(f.root, { recursive: true, force: true });
  }
});

test('foreign port owner is preserved; fallback is sticky across simultaneous and warm launches', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); const other = http.createServer((q,r)=>r.end('another application'));
  const pids = new Set();
  try {
    fs.writeFileSync(path.join(f.root, 'server.mjs'), stub);
    other.listen(f.port, '127.0.0.1'); await once(other, 'listening');
    const results = await Promise.all([f.run(), f.run()]);
    results.forEach(r => pids.add(r.pid));
    assert.equal(results.filter(r => !r.reused).length, 1);
    assert.equal(results[0].url, results[1].url);
    assert.deepEqual(deskServicePids(f.root), [results[0].pid], 'updates find only this app service, including fallback ports');
    assert.notEqual(results[0].port, f.port);
    assert.equal((await f.run()).url, results[0].url);
    assert.equal(await (await fetch(f.url)).text(), 'another application');
    await new Promise(r=>other.close(r));
    assert.equal((await f.run()).url, results[0].url, 'keep the working origin when the preferred port becomes free');
    assert.equal(fs.readFileSync(path.join(f.env.STUDYDESK_HOME, 'starts'), 'utf8'), 'start\n');
  } finally {
    for (const pid of pids) try { process.kill(pid, 'SIGTERM'); } catch {}
    if (other.listening) await new Promise(r=>other.close(r));
    fs.rmSync(f.root, { recursive:true, force:true });
  }
});

test('real server bind failure exits with a retryable code instead of leaving an unbound process', async () => {
  const f = await fixture(); const other = http.createServer((q,r)=>r.end('foreign'));
  try {
    fs.copyFileSync(new URL('../server.mjs', import.meta.url), path.join(f.root, 'server.mjs'));
    fs.copyFileSync(new URL('../feishu-url.mjs', import.meta.url), path.join(f.root, 'feishu-url.mjs'));
    fs.cpSync(new URL('../lib/', import.meta.url), path.join(f.root, 'lib'), { recursive: true });
    other.listen(f.port, '127.0.0.1'); await once(other, 'listening');
    await assert.rejects(exec(process.execPath, ['server.mjs'], { cwd: f.root, env: f.env, timeout: 5000 }),
      error => error.code === 98 && error.stderr.includes('EADDRINUSE'));
    assert.equal(await (await fetch(f.url)).text(), 'foreign');
  } finally { await new Promise(r=>other.close(r)); fs.rmSync(f.root, { recursive: true, force: true }); }
});

test('lsof escaped Chinese paths decode byte sequences without losing literal backslashes', () => {
  assert.equal(decodeLsofPath('/Applications/\\xe7\\xbd\\x91\\xe8\\xaf\\xbe.app'), '/Applications/网课.app');
  assert.equal(decodeLsofPath('/tmp/\\x5cxe7'), '/tmp/\\xe7');
});

test('a bind race retries a fresh port and a stale runtime file is ignored', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); let pid;
  try {
    fs.writeFileSync(path.join(f.root, 'server.mjs'), `import fs from 'node:fs';
const seen = process.env.STUDYDESK_HOME + '/race';
if (!fs.existsSync(seen)) { fs.writeFileSync(seen, 'raced'); process.exit(98); }
${stub}`.replace("import http from 'node:http'; import fs from 'node:fs';", "import http from 'node:http';"));
    const result = await f.run(); pid = result.pid;
    assert.notEqual(result.port, f.port);
    assert.equal(result.ok, true);
    assert.equal(isDeskProcess(pid, f.root), true);
    process.kill(pid, 'SIGTERM'); pid = undefined;
    await new Promise(r => setTimeout(r, 200));
    for (const name of fs.readdirSync(path.join(f.env.STUDYDESK_HOME, '.study-desk'))) {
      if (name.endsWith('.json')) fs.writeFileSync(path.join(f.env.STUDYDESK_HOME, '.study-desk', name), '{broken');
    }
    const restarted = await f.run(); pid = restarted.pid;
    assert.equal(restarted.reused, false);
    assert.equal(restarted.port, f.port);
  } finally { if (pid) try { process.kill(pid, 'SIGTERM'); } catch {} fs.rmSync(f.root, { recursive:true, force:true }); }
});

test('failed service start returns a visible reason and releases the startup guard', { skip: process.platform !== 'darwin' }, async () => {
  const f = await fixture(); let pid;
  try {
    fs.writeFileSync(path.join(f.root, 'server.mjs'), 'process.exit(42);');
    await assert.rejects(f.run, e => JSON.parse(e.stderr.trim().split('\n').at(-1)).error.includes('退出码 42'));
    fs.writeFileSync(path.join(f.root, 'server.mjs'), stub);
    const retried = await f.run(); pid = retried.pid;
    assert.equal(retried.ok, true); assert.equal(retried.reused, false);
  } finally { if (pid) try { process.kill(pid, 'SIGTERM'); } catch {} fs.rmSync(f.root, { recursive:true, force:true }); }
});
