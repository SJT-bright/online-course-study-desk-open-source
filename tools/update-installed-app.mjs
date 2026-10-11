import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { planAppDataMigration, applyAppDataMigration, rollbackAppDataMigration } from '../lib/app-data-migration.mjs';
import { deskServicePids } from '../lib/desktop-process.mjs';

const source = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
if (args.some(a => a !== '--no-restart')) throw new Error('支持的参数：--no-restart');
const restart = !args.includes('--no-restart');
const app = path.resolve(process.env.STUDYDESK_APP || '/Applications/网课学习工作台.app');
const target = path.join(app, 'Contents/Resources/app');
const plist = path.join(app, 'Contents/Info.plist');
if (!app.endsWith('.app') || !fs.existsSync(target) || !fs.existsSync(plist)) throw new Error('未找到完整的已安装应用：' + app);
const sourceHtml = fs.readFileSync(path.join(source, '网课学习工作台.html'), 'utf8');
const version = sourceHtml.match(/const VER = "(\d+\.\d+(?:\.\d+)?)";/)?.[1];
if (!version) throw new Error('无法读取界面版本，未进行更新');
const plutil = (...a) => execFileSync('/usr/bin/plutil', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const oldVersion = plutil('-extract', 'CFBundleShortVersionString', 'raw', plist);
const digest = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const launcherSource = path.join(source, 'macos/build/StudyDesk');
const launcherTarget = path.join(app, 'Contents/MacOS/StudyDesk');
const nativeBuild = fs.existsSync(path.join(source, 'macos/StudyDesk.swift'));
const launcherStamp = path.join(app, 'Contents/Resources/launcher-source.sha256');
const signatureDir = path.join(app, 'Contents/_CodeSignature');
if (nativeBuild && !fs.existsSync(launcherSource)) {
  throw new Error('请先运行 bash tools/build-macos-launcher.sh 构建原生启动器；尚未更新任何文件。');
}
const buildDigest = fs.existsSync(launcherSource) ? digest(launcherSource) : null;
if (nativeBuild) execFileSync('/usr/bin/codesign', ['--verify', '--strict', launcherSource], { stdio: 'pipe' });
// Bundle signing adds Info/Resources seals to the executable. Remember the
// verified source build so those signature bytes do not force every update.
const launcherChanged = !!buildDigest && (!fs.existsSync(launcherTarget) || (nativeBuild
  ? !fs.existsSync(launcherStamp) || fs.readFileSync(launcherStamp, 'utf8').trim() !== buildDigest
  : buildDigest !== digest(launcherTarget)));
const syncLauncher = (from, to) => {
  const temp = to + '.update-' + process.pid;
  try { fs.copyFileSync(from, temp); fs.chmodSync(temp, 0o755); fs.renameSync(temp, to); }
  finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
};
const files = ['网课学习工作台.html', 'server.mjs', 'feishu-url.mjs', '转写配置指南.html', '使用说明.md', 'README.md'];
for (const dir of ['lib', 'vendor']) {
  for (const entry of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) {
    if (entry.isFile() && /\.(mjs|cjs|js|css|py)$/.test(entry.name)) files.push(dir + '/' + entry.name);
  }
}
for (const name of ['package.json', 'package-lock.json']) files.push('local-asr/' + name);
const asrModules = path.join(source, 'local-asr/node_modules');
if (fs.existsSync(asrModules)) {
  const addRuntimeFiles = (dir) => {
    for (const entry of fs.readdirSync(path.join(source, dir), { withFileTypes: true })) {
      const rel = dir + '/' + entry.name;
      if (entry.isDirectory()) addRuntimeFiles(rel);
      else if (entry.isFile()) files.push(rel);
    }
  };
  addRuntimeFiles('local-asr/node_modules');
}
// Explicit code-only whitelist: never mirror tools/, downloads/, models or credentials.
if (fs.existsSync(path.join(source, 'tools/yt-dlp_macos'))) files.push('tools/yt-dlp_macos');
const changed = files.filter(f => !fs.existsSync(path.join(target, f)) || digest(path.join(source, f)) !== digest(path.join(target, f)));
let bundleId = ''; try { bundleId = plutil('-extract', 'CFBundleIdentifier', 'raw', plist); } catch {}
const dataPlan = nativeBuild && bundleId === 'local.studydesk.app' ? planAppDataMigration(target, os.homedir()) : [];
let needsSigning = nativeBuild && (dataPlan.length > 0 || launcherChanged || changed.length > 0 || oldVersion !== version);
if (nativeBuild && !needsSigning) {
  try { execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe' }); }
  catch { needsSigning = true; }
}
const pids = () => deskServicePids(target);
fs.accessSync(target, fs.constants.W_OK); fs.accessSync(plist, fs.constants.W_OK);
if (launcherChanged || needsSigning) fs.accessSync(path.dirname(launcherTarget), fs.constants.W_OK);
let backup = null;
if (changed.length || launcherChanged || needsSigning || oldVersion !== version) {
  const backupRoot = path.join(source, '.backups'); fs.mkdirSync(backupRoot, { recursive: true });
  backup = fs.mkdtempSync(path.join(backupRoot, new Date().toISOString().replace(/[:.]/g, '-') + '-before-v' + version + '-'));
  fs.copyFileSync(plist, path.join(backup, 'Info.plist'));
  if ((launcherChanged || needsSigning) && fs.existsSync(launcherTarget)) fs.copyFileSync(launcherTarget, path.join(backup, 'StudyDesk'));
  if (needsSigning && fs.existsSync(signatureDir)) fs.cpSync(signatureDir, path.join(backup, '_CodeSignature'), { recursive: true });
  if (needsSigning && fs.existsSync(launcherStamp)) fs.copyFileSync(launcherStamp, path.join(backup, 'launcher-source.sha256'));
  for (const f of changed) {
    const previous = path.join(target, f);
    if (!fs.existsSync(previous)) continue;
    fs.mkdirSync(path.dirname(path.join(backup, 'app', f)), { recursive: true });
    fs.copyFileSync(previous, path.join(backup, 'app', f));
  }
  fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify({ app, oldVersion, version, launcher: launcherChanged ? { path: 'Contents/MacOS/StudyDesk', existed: fs.existsSync(launcherTarget), before: fs.existsSync(launcherTarget) ? digest(launcherTarget) : null, after: digest(launcherSource) } : null, files: changed.map(f => ({ path: f, existed: fs.existsSync(path.join(target, f)), before: fs.existsSync(path.join(target, f)) ? digest(path.join(target, f)) : null, after: digest(path.join(source, f)) })), data: 'User file contents are preserved. Writable bundle data may be relocated; see data-migration.json.' }, null, 2));
    console.log('旧版程序备份：' + backup);
}
let stopped = false;
let movedData = [];
let serviceURL;
async function startServer() {
  const env = { ...process.env, STUDYDESK_PORT: '8790' };
  for (const key of Object.keys(env)) if (key.startsWith('STUDYDESK_') && key !== 'STUDYDESK_PORT') delete env[key];
  const output = execFileSync(process.execPath, [path.join(target, 'lib/desktop-start.mjs')],
    { cwd: target, env, encoding: 'utf8', timeout: 50000 });
  const result = JSON.parse(output.trim());
  if (!result.ok || !pids().includes(result.pid)) throw new Error('服务未通过启动检查');
  serviceURL = result.url;
  return result.pid;
}
try {
  if (restart) {
    const active = pids();
    for (const pid of active) process.kill(pid, 'SIGTERM');
    stopped = true;
    for (let i = 0; i < 50 && pids().length; i++) await delay(100);
    if (pids().length) throw new Error('旧服务尚未退出，未覆盖程序文件');
  }
  movedData = applyAppDataMigration(dataPlan);
  if (backup && movedData.length) fs.writeFileSync(path.join(backup, 'data-migration.json'), JSON.stringify(movedData, null, 2));
  for (const f of changed) {
    const dest = path.join(target, f); fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(source, f), dest);
    if (digest(dest) !== digest(path.join(source, f))) throw new Error('同步校验失败：' + f);
  }
  if (launcherChanged) {
    syncLauncher(launcherSource, launcherTarget);
    if (digest(launcherTarget) !== digest(launcherSource)) throw new Error('原生启动器同步校验失败');
  }
  plutil('-replace', 'CFBundleShortVersionString', '-string', version, plist);
  plutil('-replace', 'CFBundleVersion', '-string', version, plist);
  if (needsSigning) {
    if (!launcherChanged) syncLauncher(launcherTarget, launcherTarget);
    fs.writeFileSync(launcherStamp, buildDigest + '\n');
    execFileSync('/usr/bin/codesign', ['--force', '--sign', '-', '--timestamp=none', app], { stdio: 'pipe' });
    execFileSync('/usr/bin/codesign', ['--verify', '--strict', app], { stdio: 'pipe' });
  }
} catch (error) {
  if (movedData.length) rollbackAppDataMigration(movedData);
  if (backup) {
    for (const f of changed) {
      const previous = path.join(backup, 'app', f);
      if (fs.existsSync(previous)) fs.copyFileSync(previous, path.join(target, f));
      else if (fs.existsSync(path.join(target, f))) fs.unlinkSync(path.join(target, f));
    }
    fs.copyFileSync(path.join(backup, 'Info.plist'), plist);
    if (launcherChanged || needsSigning) {
      if (fs.existsSync(path.join(backup, 'StudyDesk'))) syncLauncher(path.join(backup, 'StudyDesk'), launcherTarget);
      else if (fs.existsSync(launcherTarget)) fs.unlinkSync(launcherTarget);
    }
    if (needsSigning) {
      if (fs.existsSync(signatureDir)) fs.rmSync(signatureDir, { recursive: true });
      if (fs.existsSync(path.join(backup, '_CodeSignature'))) fs.cpSync(path.join(backup, '_CodeSignature'), signatureDir, { recursive: true });
      if (fs.existsSync(path.join(backup, 'launcher-source.sha256'))) fs.copyFileSync(path.join(backup, 'launcher-source.sha256'), launcherStamp);
      else if (fs.existsSync(launcherStamp)) fs.unlinkSync(launcherStamp);
    }
  }
  if (stopped && !pids().length) await startServer();
  throw error;
}
const pid = restart ? await startServer() : null;
if (restart) {
  const served = await (await fetch(serviceURL)).text();
  /* 服务端会把 __SD_API_TOKEN__ 占位符替换为一次性令牌，比较前还原为占位符形态 */
  const servedPlain = served.replace(/const __SD_TOKEN = "[0-9a-f]+"/, 'const __SD_TOKEN = "__SD_API_TOKEN__"');
  if (servedPlain !== sourceHtml) throw new Error('服务返回的界面与源文件不一致');
  const quitGui = (script) => { try { execFileSync('/usr/bin/osascript', ['-e', script], { timeout: 4000, stdio: 'ignore' }); } catch {} };
  quitGui('tell application id "local.studydesk.app" to quit');
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    try { execFileSync('/usr/bin/pgrep', ['-x', 'StudyDesk'], { stdio: 'ignore' }); }
    catch { break; }
    await delay(150);
  }
  await delay(300);
  execFileSync('/usr/bin/open', ['-a', app]);
}
console.log(JSON.stringify({ version, app, backup, updatedFiles: changed, updatedLauncher: launcherChanged, signed: needsSigning, movedData, pid, url: serviceURL, restarted: restart, dataPreserved: true }, null, 2));
if (!restart) console.log('程序文件已同步，现有后端保持运行；有后台代码改动时，请在无任务时运行不带 --no-restart 的更新命令。');
