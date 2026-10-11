import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { planAppDataMigration, applyAppDataMigration, rollbackAppDataMigration, appDataResolver } from '../lib/app-data-migration.mjs';

test('writable data relocation preserves old paths and a signed bundle remains valid after writes', { skip: process.platform !== 'darwin' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sd-data-'));
  try {
    const app = path.join(dir, 'Test.app'), root = path.join(app, 'Contents/Resources/app'), home = path.join(dir, 'home');
    fs.mkdirSync(path.join(root, 'downloads/transcripts'), { recursive: true });
    fs.mkdirSync(path.join(root, 'tools/models'), { recursive: true });
    fs.mkdirSync(path.join(app, 'Contents/MacOS'), { recursive: true });
    fs.copyFileSync(new URL('../macos/build/StudyDesk', import.meta.url), path.join(app, 'Contents/MacOS/StudyDesk'));
    fs.writeFileSync(path.join(app, 'Contents/Info.plist'), '<?xml version="1.0"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>local.studydesk.data-test</string><key>CFBundleExecutable</key><string>StudyDesk</string><key>CFBundlePackageType</key><string>APPL</string></dict></plist>');
    const index = path.join(root, 'downloads/transcripts/index.json'); fs.writeFileSync(index, 'original');
    const before = fs.statSync(index).ino;
    const moved = applyAppDataMigration(planAppDataMigration(root, home));
    const resolve = appDataResolver(root);
    assert.equal(fs.statSync(resolve(index)).ino, before);
    assert.equal(fs.existsSync(index), false);
    assert.deepEqual(planAppDataMigration(root, home), []);
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app], { stdio: 'pipe' });
    fs.writeFileSync(resolve(index), 'new transcription');
    fs.writeFileSync(resolve(path.join(root, 'tools/models/new-model.bin')), 'model');
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe' });
    rollbackAppDataMigration(moved);
    assert.equal(fs.lstatSync(path.join(root, 'downloads')).isSymbolicLink(), false);
    assert.equal(fs.readFileSync(index, 'utf8'), 'new transcription');
    const plan = planAppDataMigration(root, home); fs.mkdirSync(plan[0].to);
    assert.throws(() => planAppDataMigration(root, home), /已存在/);
    assert.equal(fs.readFileSync(index, 'utf8'), 'new transcription');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
