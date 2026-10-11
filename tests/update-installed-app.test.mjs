import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

test('app updater backs up code, derives version, preserves user files and is idempotent', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-update-test-'));
  try {
    const source = path.join(dir, 'source'), app = path.join(dir, 'Test.app'), target = path.join(app, 'Contents/Resources/app');
    for (const base of [source, target]) for (const sub of ['lib', 'vendor', 'tools/models', 'downloads']) fs.mkdirSync(path.join(base, sub), { recursive: true });
    fs.mkdirSync(path.join(source, 'local-asr/node_modules/sherpa-onnx-node'), { recursive: true });
    fs.mkdirSync(path.join(source, 'macos/build'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    fs.writeFileSync(path.join(source, 'macos/build/StudyDesk'), 'new native launcher');
    fs.writeFileSync(path.join(app, 'Contents/MacOS/StudyDesk'), 'old launcher');
    fs.copyFileSync(new URL('../tools/update-installed-app.mjs', import.meta.url), path.join(source, 'tools/update-installed-app.mjs'));
    fs.copyFileSync(new URL('../lib/app-data-migration.mjs', import.meta.url), path.join(source, 'lib/app-data-migration.mjs'));
    fs.copyFileSync(new URL('../lib/desktop-process.mjs', import.meta.url), path.join(source, 'lib/desktop-process.mjs'));
    for (const f of ['server.mjs', 'feishu-url.mjs', '转写配置指南.html', '使用说明.md', 'README.md', 'lib/example.mjs', 'lib/bili-asr-worker.py', 'vendor/example.js']) fs.writeFileSync(path.join(source, f), 'new code');
    for (const f of ['local-asr/package.json', 'local-asr/package-lock.json', 'local-asr/node_modules/sherpa-onnx-node/sherpa-onnx.node']) fs.writeFileSync(path.join(source, f), 'runtime');
    fs.writeFileSync(path.join(source, '网课学习工作台.html'), 'const VER = "3.3";');
    fs.writeFileSync(path.join(target, '网课学习工作台.html'), 'old page');
    for (const f of ['downloads/lesson.txt', 'tools/models/model.bin', 'tools/bili-cookies.txt', 'tools/app-only-tool', 'lib/app-only.mjs']) fs.writeFileSync(path.join(target, f), 'keep me');
    const plist = path.join(app, 'Contents/Info.plist');
    fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>3.0</string><key>CFBundleVersion</key><string>3.0</string></dict></plist>');
    const run = () => execFileSync(process.execPath, [path.join(source, 'tools/update-installed-app.mjs'), '--no-restart'], { env: { ...process.env, STUDYDESK_APP: app }, encoding: 'utf8' });
    const first = run(); assert.ok(first.includes('"version": "3.3"'));
    assert.equal(fs.readFileSync(path.join(target, '网课学习工作台.html'), 'utf8'), 'const VER = "3.3";');
    assert.equal(fs.readFileSync(path.join(app, 'Contents/MacOS/StudyDesk'), 'utf8'), 'new native launcher');
    assert.equal(fs.statSync(path.join(app, 'Contents/MacOS/StudyDesk')).mode & 0o777, 0o755);
    assert.equal(fs.readFileSync(path.join(target, 'lib/bili-asr-worker.py'), 'utf8'), 'new code');
    assert.equal(fs.readFileSync(path.join(target, 'local-asr/node_modules/sherpa-onnx-node/sherpa-onnx.node'), 'utf8'), 'runtime');
    for (const f of ['downloads/lesson.txt', 'tools/models/model.bin', 'tools/bili-cookies.txt', 'tools/app-only-tool', 'lib/app-only.mjs']) assert.equal(fs.readFileSync(path.join(target, f), 'utf8'), 'keep me');
    const backups = fs.readdirSync(path.join(source, '.backups')); assert.equal(backups.length, 1);
    assert.equal(fs.readFileSync(path.join(source, '.backups', backups[0], 'app/网课学习工作台.html'), 'utf8'), 'old page');
    assert.equal(fs.readFileSync(path.join(source, '.backups', backups[0], 'StudyDesk'), 'utf8'), 'old launcher');
    assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', plist], { encoding: 'utf8' }).trim(), '3.3');
    assert.ok(run().includes('"updatedFiles": []'));
    assert.equal(fs.readdirSync(path.join(source, '.backups')).length, 1);
    const native = new URL('../macos/build/StudyDesk', import.meta.url);
    if (fs.existsSync(native)) {
      fs.writeFileSync(path.join(source, 'macos/StudyDesk.swift'), '// native source');
      fs.copyFileSync(native, path.join(source, 'macos/build/StudyDesk'));
      for (const [key, value] of [['CFBundleIdentifier', 'local.studydesk.update-test'], ['CFBundleExecutable', 'StudyDesk'], ['CFBundlePackageType', 'APPL']]) {
        execFileSync('/usr/bin/plutil', ['-insert', key, '-string', value, plist]);
      }
      const nativeResult = run(); assert.ok(nativeResult.includes('"signed": true'));
      execFileSync('/usr/bin/codesign', ['--verify', '--strict', app]);
      assert.ok(run().includes('"updatedLauncher": false'));
      assert.equal(fs.readdirSync(path.join(source, '.backups')).length, 2, 'signed bundle update is also idempotent');
      assert.equal(fs.readFileSync(path.join(target, 'downloads/lesson.txt'), 'utf8'), 'keep me');
    }
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('missing native launcher build refuses the update before touching installed files', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-update-build-'));
  try {
    const source = path.join(dir, 'source'), app = path.join(dir, 'Test.app'), target = path.join(app, 'Contents/Resources/app');
    fs.mkdirSync(path.join(source, 'tools'), { recursive: true });
    fs.mkdirSync(path.join(source, 'macos'), { recursive: true });
    fs.mkdirSync(target, { recursive: true });
    fs.mkdirSync(path.join(source, 'lib'), { recursive: true });
    fs.copyFileSync(new URL('../lib/app-data-migration.mjs', import.meta.url), path.join(source, 'lib/app-data-migration.mjs'));
    fs.copyFileSync(new URL('../lib/desktop-process.mjs', import.meta.url), path.join(source, 'lib/desktop-process.mjs'));
    fs.copyFileSync(new URL('../tools/update-installed-app.mjs', import.meta.url), path.join(source, 'tools/update-installed-app.mjs'));
    fs.writeFileSync(path.join(source, 'macos/StudyDesk.swift'), '// native source');
    fs.writeFileSync(path.join(source, '网课学习工作台.html'), 'const VER = "3.6.7";');
    fs.writeFileSync(path.join(target, '网课学习工作台.html'), 'keep old page');
    const plist = path.join(app, 'Contents/Info.plist');
    fs.writeFileSync(plist, '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleShortVersionString</key><string>3.6.6</string><key>CFBundleVersion</key><string>3.6.6</string></dict></plist>');
    assert.throws(() => execFileSync(process.execPath, [path.join(source, 'tools/update-installed-app.mjs'), '--no-restart'], { env: { ...process.env, STUDYDESK_APP: app }, stdio: 'pipe' }), e=>e.stderr.toString().includes('build-macos-launcher.sh'));
    assert.equal(fs.readFileSync(path.join(target, '网课学习工作台.html'), 'utf8'), 'keep old page');
    assert.equal(execFileSync('/usr/bin/plutil', ['-extract', 'CFBundleVersion', 'raw', plist], { encoding: 'utf8' }).trim(), '3.6.6');
    assert.equal(fs.existsSync(path.join(source, '.backups')), false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
