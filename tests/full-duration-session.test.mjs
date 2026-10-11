import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

test('fullDurationSec 保留全片时长，非法时长抛出未取得视频时长', async () => {
  let fullDurationSec;
  try {
    ({ fullDurationSec } = await import('../lib/bili-transcript.mjs'));
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes('fullDurationSec')) assert.fail('fullDurationSec 未导出');
    throw error;
  }
  if (typeof fullDurationSec !== 'function') assert.fail('fullDurationSec 未导出');

  // 4 小时 22 分 29 秒，不能被收成 1800。
  assert.equal(fullDurationSec({ duration: 15749 }), 15749);
  assert.equal(fullDurationSec({ duration: 1800.9 }), 1800);
  for (const info of [{ duration: 0 }, {}, { duration: -1 }, { duration: 86401 }]) {
    assert.throws(() => fullDurationSec(info), /未取得视频时长/);
  }
});

test('session 目录只在 downloadDir/session/<uuid>，discard 只删除其中的文件', async () => {
  const downloadDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-session-dl-'));
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-session-out-'));
  const outside = path.join(outsideDir, 'keep.mp4');
  fs.writeFileSync(outside, 'keep-me');
  try {
    const { allocateSessionDir, discardSessionFile } = await import('../lib/session-media.mjs');
    assert.equal(typeof allocateSessionDir, 'function');
    assert.equal(typeof discardSessionFile, 'function');

    const allocated = allocateSessionDir(downloadDir);
    const dir = allocated && typeof allocated === 'object' ? allocated.dir : allocated;
    assert.equal(typeof dir, 'string');
    const relLogical = path.relative(path.join(path.resolve(downloadDir), 'session'), path.resolve(dir));
    let relReal = '';
    try {
      relReal = path.relative(path.join(fs.realpathSync(downloadDir), 'session'), fs.realpathSync(dir));
    } catch { /* 目录不存在时由下面的 stat 失败 */ }
    assert.ok(UUID_DIR.test(relLogical) || UUID_DIR.test(relReal), `dir 不在 downloadDir/session/<uuid> 下: ${dir}`);
    assert.equal(fs.statSync(dir).isDirectory(), true);

    const file = path.join(dir, 'fake.mp4');
    fs.writeFileSync(file, 'fake-mp4');
    const discarded = discardSessionFile(downloadDir, file);
    assert.equal(discarded.ok, true);
    assert.equal(fs.existsSync(file), false);

    assert.throws(() => discardSessionFile(downloadDir, outside));
    assert.equal(fs.existsSync(outside), true);
    assert.equal(fs.readFileSync(outside, 'utf8'), 'keep-me');

    const sessionRoot = path.join(downloadDir, 'session');
    assert.throws(() => discardSessionFile(downloadDir, sessionRoot));
    assert.equal(fs.statSync(sessionRoot).isDirectory(), true);
    assert.equal(fs.existsSync(dir), false);
  } finally {
    fs.rmSync(downloadDir, { recursive: true, force: true });
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});
