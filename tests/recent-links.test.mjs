import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { openRecentLinks } from '../lib/recent-links.mjs';

test('recent links persist, deduplicate Bili parts, and enforce a configurable 1–50 limit', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-recent-'));
  try {
    const file = path.join(dir, 'recent.json'), store = openRecentLinks(file);
    assert.equal(store.list().limit, 20);
    store.add({ url: 'https://www.bilibili.com/video/BV1abc/?p=2&t=12&share_source=test', name: 'first' });
    store.add({ url: 'https://www.bilibili.com/video/BV1abc/?p=2&t=20', name: 'again' });
    store.add({ url: 'https://www.bilibili.com/video/BV1abc/?p=1', name: 'P1' });
    assert.equal(openRecentLinks(file).list().items.length, 2);
    assert.equal(store.list().items[1].name, 'again');
    assert.match(store.list().items[1].url, /t=20$/);
    store.setLimit(50);
    for (let i = 0; i < 55; i++) store.add({ url: `https://example.com/${i}`, platform: 'other' });
    assert.equal(store.list().items.length, 50);
    assert.equal(store.list('bili').items.length, 0);
    store.setLimit(1); assert.equal(store.list().items[0].url, 'https://example.com/54');
    for (const value of [0, 51, 1.5, '20']) assert.throws(() => store.setLimit(value));
    assert.equal(openRecentLinks(file).list().limit, 1);
    assert.throws(() => store.add({ url: 'javascript:alert(1)' }));
    store.remove(store.list().items[0].key); assert.equal(store.list().items.length, 0);
    fs.writeFileSync(file, 'broken'); assert.throws(() => store.add({ url: 'https://example.com' }));
    assert.equal(fs.readFileSync(file, 'utf8'), 'broken');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('course transcription matching separates Bili parts and uses source identities rather than titles', () => {
  const html = fs.readFileSync(new URL('../网课学习工作台.html', import.meta.url), 'utf8');
  const source = html.split('/* resource-transcript-match:start */')[1].split('/* resource-transcript-match:end */')[0];
  const ctx = vm.createContext({ URL }); vm.runInContext(source, ctx);
  const items = [{ id: 'p1', pageUrl: 'https://www.bilibili.com/video/BV1abc/?p=1' }, { id: 'p2', pageUrl: 'https://www.bilibili.com/video/BV1abc/?p=2' }, { id: 'local', sourceKey: 'srv:/video.mp4' }];
  assert.equal(ctx.transcriptsForResource(items, { key: 'bili:BV1abc:123:2', source: 'https://www.bilibili.com/video/BV1abc?p=2&t=10' })[0].id, 'p2');
  assert.equal(ctx.transcriptsForResource(items, { key: 'srv:/video.mp4', source: '/video.mp4' })[0].id, 'local');
  assert.equal(ctx.transcriptsForResource(items, { key: 'new', name: 'p1' }).length, 0);
  assert.equal(ctx.transcriptsForResource([{id:'failed',sourceKey:'k',status:'error',startedAt:200},{id:'done',sourceKey:'k',status:'done',startedAt:100}], {key:'k'})[0].id, 'done');
});
