import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { openLocalWindow, uiSocketPath } from '../lib/desktop-window.mjs';

test('openLocalWindow talks only to the local app socket', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ui-'));
  const sock = uiSocketPath(home);
  if (process.platform !== 'win32') fs.mkdirSync(path.dirname(sock), { recursive: true });
  let received = '';
  const server = net.createServer((client) => {
    client.on('data', (chunk) => { received += chunk; });
    client.on('end', () => client.end());
  });
  await new Promise((resolve) => server.listen(sock, resolve));
  try {
    const opened = await openLocalWindow('https://example.com/lesson', home);
    assert.deepEqual(opened, { ok: true, mode: 'app' });
    assert.deepEqual(JSON.parse(received), { url: 'https://example.com/lesson' });
    await assert.rejects(openLocalWindow('file:///tmp/x', home), /无效链接/);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('missing local app does not invent another opener', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-ui-miss-'));
  try {
    await assert.rejects(openLocalWindow('http://127.0.0.1:8790/', home), /本地应用窗口未就绪/);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
