import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import vm from 'node:vm';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';

const html = fs.readFileSync(new URL('../网课学习工作台.html', import.meta.url), 'utf8');
function sourceFunction(name) {
  const start = html.search(new RegExp(`(?:async )?function ${name}\\(`));
  assert.ok(start >= 0, name);
  for (let end = html.indexOf('\n', start); end >= 0; end = html.indexOf('\n', end + 1)) {
    const code = html.slice(start, end);
    try { new vm.Script(`(${code})`); return code; } catch {}
  }
  throw new Error(`Missing function end: ${name}`);
}
function sandbox(names, values = {}) {
  const ctx = vm.createContext({ URL, ...values });
  names.forEach(name => vm.runInContext(sourceFunction(name), ctx));
  return ctx;
}

test('all inline JavaScript parses', () => {
  for (const m of html.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)) new vm.Script(m[1]);
});
test('note mirror preserves in-flight edits, retries outages and saves cleared notes', async () => {
  const storage = new Map(), timers = new Map(), requests = [];
  let timerId = 0, online = true, hold = null, noteHtml = '<p>first</p>';
  const ctx = vm.createContext({
    console, Date, Math,
    document: { getElementById: () => ({}) }, window: { addEventListener() {} },
    localStorage: { getItem: k => storage.get(k), setItem: (k, v) => storage.set(k, v), removeItem: k => storage.delete(k) },
    setTimeout: (fn, ms) => { timers.set(++timerId, { fn, ms }); return timerId; }, clearTimeout: id => timers.delete(id),
    idbGet: async key => key.startsWith('note:') ? { html: noteHtml, savedAt: 1 } : null,
    fetch: async (url, opts) => {
      if (!online) throw new Error('offline');
      if (url.endsWith('/status')) return { json: async () => ({ available: true }) };
      requests.push(JSON.parse(opts.body));
      if (hold) await hold;
      return { ok: true };
    },
  });
  vm.runInContext(html.slice(html.indexOf('const noteSync = (() => {'), html.indexOf('\nnoteSync.probe().then(async')), ctx);
  const sync = vm.runInContext('noteSync', ctx);
  await sync.probe(); sync.enqueue('a');
  let release; hold = new Promise(resolve => { release = resolve; });
  const first = sync.flush();
  for (let i = 0; i < 20 && !requests.length; i++) await Promise.resolve();
  assert.equal(requests.length, 1);
  sync.enqueue('a'); sync.enqueue('b');
  release(); hold = null; await first;
  assert.deepEqual(Object.keys(JSON.parse(storage.get('studydesk-nsq'))).sort(), ['a', 'b']);
  await sync.flush();
  assert.equal(Object.keys(JSON.parse(storage.get('studydesk-nsq'))).length, 0);
  noteHtml = ''; sync.enqueue('a'); await sync.flush();
  assert.equal(requests.at(-1).html, '', 'clearing a note also clears its stale database mirror');
  online = false; await sync.probe(); sync.enqueue('c'); await sync.flush();
  assert.ok(JSON.parse(storage.get('studydesk-nsq')).c);
  assert.ok([...timers.values()].some(t => t.ms >= 3000), 'automatic retry is scheduled');
  online = true; await sync.flush();
  assert.equal(Object.keys(JSON.parse(storage.get('studydesk-nsq'))).length, 0);
});
test('continuous 20-minute transcript splits at elapsed 5-minute boundaries', () => {
  const ctx = sandbox(['sttEsc', 'sttSec', 'sttChipHtml', 'sttBuildOutline'], { fmt: sec => `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(Math.floor(sec % 60)).padStart(2, '0')}` });
  const item = { title: '<img src=x>', startedAt: 0, lines: Array.from({ length: 120 }, (_, i) => ({ t0: i * 10000, t1: i * 10000 + 9000, text: '<b>内容</b>' })) };
  const output = ctx.sttBuildOutline(item, 5);
  assert.equal((output.match(/<h3>/g) || []).length, 4);
  assert.ok(!output.includes('<img') && !output.includes('<b>内容'));
  assert.ok(output.includes('data-t="300"') && output.includes('data-t="900"'));
  assert.equal(ctx.sttBuildOutline({ lines: item.lines.slice(0, 3) }, 5), null);
});
test('transcript text and search highlighting remain inert text', () => {
  const ctx = sandbox(['sttEsc', 'sttHl']);
  assert.equal(ctx.sttHl('<img onerror=x>', ''), '&lt;img onerror=x&gt;');
  assert.equal(ctx.sttHl('a & b', '&'), 'a <mark>&amp;</mark> b');
  assert.equal(ctx.sttHl('a[1]', '[1]'), 'a<mark>[1]</mark>');
});
test('compatibility URLs preserve SPA hash and await authorization failure', async () => {
  const ctx = sandbox(['proxyUrlFor', 'ensureProxyAllowed'], { fetch: async () => ({ ok: false, json: async () => ({ error: 'denied' }) }) });
  assert.equal(ctx.proxyUrlFor('https://example.com/course?q=1#/lesson/2'), '/api/proxy/https/example.com/course?q=1#/lesson/2');
  await assert.rejects(ctx.ensureProxyAllowed('https://example.com/'), /denied/);
});
test('transcript course routing does not append to another course', async () => {
  const writes = [], registrations = [];
  const ctx = sandbox(['sttAppendToNote'], {
    videoKey: 'course-b', videoBase: 'B',
    idbGet: async () => ({ courseId: 'b', name: 'B' }), confirm: () => true,
    paper: { insertAdjacentHTML: (_, value) => writes.push(value), dispatchEvent() {} },
    Event: class {}, flashSaved() {}, flushPaperSave: async () => {},
    $: () => null,
    studyDesk: { register: async (...args) => registrations.push(args), openResource: async key => { ctx.videoKey = key; } },
  });
  assert.equal(await ctx.sttAppendToNote({ id: 't1', course: 'a', courseName: 'A' }, '<p>A</p>'), true);
  assert.equal(registrations[0][2].courseId, 'a');
  assert.equal(ctx.videoKey, 'transcript:t1');
  assert.equal(writes.length, 1);
  ctx.videoKey = 'course-b';
  assert.equal(await ctx.sttAppendToNote({ id: 't2', course: 'a' }, '<p>A</p>'), true);
  assert.equal(ctx.videoKey, 'transcript:t2');
  assert.equal(writes.length, 2);
});

test('transcript restore, correction, search, export and backup agree', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-transcript-test-'));
  const probe = net.createServer(); probe.listen(0, '127.0.0.1'); await once(probe, 'listening');
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const child = spawn(process.execPath, [fileURLToPath(new URL('../server.mjs', import.meta.url))], {
    env: { ...process.env, STUDYDESK_HOME: dir, STUDYDESK_TRANSCRIPTS_DIR: path.join(dir, 'transcripts'), STUDYDESK_PORT: String(port) }, stdio: 'ignore',
  });
  const origin = `http://127.0.0.1:${port}`;
  let token = "";
  const withToken = route => route + (route.includes("?") ? "&" : "?") + "sd_token=" + token;
  const post = async (route, body) => fetch(origin + withToken('/api/transcripts/' + route), { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
  const get = async route => (await fetch(origin + withToken('/api/transcripts/' + route))).json();
  try {
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        let r = await fetch(origin + '/api/version');
        if (!r.ok){ token = ((await (await fetch(origin + '/')).text()).match(/const __SD_TOKEN = "([0-9a-f]+)"/) || [])[1] || ""; if (token) r = await fetch(origin + withToken('/api/version')); }
        ready = !!r && r.ok;
      } catch {}
      if (ready) break;
      await delay(50);
    }
    assert.ok(ready, 'isolated server starts');
    const denied = await fetch(origin + withToken('/api/transcripts/restore'), { method: 'POST', headers: { origin: 'https://unrelated.example', 'content-type': 'application/json' }, body: JSON.stringify({ records: [] }) });
    assert.equal(denied.status, 403, 'transcript APIs enforce the same origin boundary as notes APIs');
    const recentPost = (route, body) => fetch(origin + withToken('/api/recent-links' + route), { method: 'POST', headers: { 'content-type': 'application/json', origin }, body: JSON.stringify(body) });
    assert.equal((await recentPost('', { url: 'https://www.bilibili.com/video/BV1abc/?p=2', name: 'P2' })).status, 200);
    assert.equal((await recentPost('/limit', { limit: 51 })).status, 400);
    assert.equal((await recentPost('/limit', { limit: 50 })).status, 200);
    const recent = await (await fetch(origin + withToken('/api/recent-links?platform=bili'))).json();
    assert.equal(recent.limit, 50); assert.equal(recent.items[0].name, 'P2');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, '.study-desk/recent-links.json'), 'utf8')).items.length, 1);
    assert.equal((await fetch(origin + '/api/recent-links')).status, 403);
    const rec = { id: 'lesson-1', startedAt: 123, title: '课程', text: '旧文本', status: 'done', lines: [{ t0: 0, t1: 9000, text: '旧文本' }] };
    const restored = await (await post('restore', { records: [rec, { ...rec, id: ' lesson-1 ' }, { ...rec, id: '../outside' }, { ...rec, id: 'bad-lines', lines: {} }, { ...rec, id: 'bad-title', title: 42 }] })).json();
    assert.equal(restored.added, 1); assert.equal(restored.skipped, 4);
    assert.equal((await post('update', { id: rec.id, lines: [{ t0: 0, t1: 9000, text: '修正文本' }] })).status, 200);
    let detail = await get('detail?id=lesson-1');
    assert.equal(detail.item.text, '修正文本'); assert.equal(detail.item.lines[0].t1, 9000);
    assert.equal((await get('search?q=' + encodeURIComponent('旧文本'))).items.length, 0);
    assert.equal((await get('search?q=' + encodeURIComponent('修正文本'))).items.length, 1);
    const exported = await (await fetch(origin + withToken('/api/transcripts/export?id=lesson-1&fmt=txt'))).text();
    assert.ok(exported.includes('修正文本') && !exported.includes('旧文本'));
    assert.equal((await get('backup')).records[0].lines[0].text, '修正文本');
    assert.equal((await post('update', { id: rec.id, lines: [{ t0: -2, t1: 1, text: 'bad' }] })).status, 400);
    assert.equal((await get('detail?id=lesson-1')).item.text, '修正文本');
    await post('update', { id: rec.id, text: '全文替换' });
    detail = await get('detail?id=lesson-1'); assert.equal(detail.item.lines.length, 0); assert.equal(detail.item.text, '全文替换');
    assert.equal((await post('delete', { id: '../outside' })).status, 400);
  } finally {
    if (child.exitCode === null && child.signalCode === null){ const exited = once(child, 'exit'); child.kill(); await exited; }
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
