const { app, BrowserWindow, protocol, session, Menu, dialog, desktopCapturer } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const exec = promisify(execFile);
const { pathToFileURL } = require('node:url');

protocol.registerSchemesAsPrivileged([{ scheme: 'studydesk', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true } }]);
app.setName('StudyDesk');
app.setPath('userData', path.join(app.getPath('appData'), 'StudyDesk'));
const smoke = process.env.STUDYDESK_SMOKE === '1';
// Test and production profiles never overlap. Updates keep this directory.
if (process.env.STUDYDESK_DESKTOP_DATA) app.setPath('userData', path.resolve(process.env.STUDYDESK_DESKTOP_DATA));
const data = app.getPath('userData');
const home = path.join(data, 'home');
const root = app.isPackaged ? path.join(process.resourcesPath, 'backend') : path.resolve(__dirname, '..');
const node = app.isPackaged ? path.join(process.resourcesPath, 'runtime', 'node.exe') : process.env.STUDYDESK_NODE || 'node';
const env = { ...process.env, STUDYDESK_HOME: home, STUDYDESK_DOWNLOAD_DIR: path.join(home, 'downloads'), STUDYDESK_MODEL_DIR: path.join(home, 'models/whisper'), STUDYDESK_MEDIA: process.env.STUDYDESK_MEDIA || path.join(app.getPath('downloads'), 'StudyDesk') };
let mainWindow, service, control;
const pages = new Set();
const launches = new Set();
const APP_URL = 'studydesk://app/';
const locked = app.requestSingleInstanceLock();
if (!locked) app.quit();
else {
  app.on('second-instance', () => { if (mainWindow) { mainWindow.show(); mainWindow.focus(); } });
  app.on('window-all-closed', () => app.quit());
  app.on('before-quit', () => control?.close());
  app.whenReady().then(start).catch(async error => {
    if (smoke) { console.error(error.stack); await fs.promises.writeFile(process.env.STUDYDESK_SMOKE_RESULT, JSON.stringify({ ok: false, error: error.stack })); app.exit(1); }
    else { dialog.showErrorBox('网课学习工作台启动失败', error.message + '\n启动日志：' + path.join(home, '.study-desk/logs/server.log')); app.quit(); }
  });
}
async function start() {
  fs.mkdirSync(home, { recursive: true });
  const started = await exec(node, [path.join(root, 'lib/desktop-start.mjs')], { cwd: root, env, timeout: 90000, windowsHide: true, maxBuffer: 1024 * 1024 });
  service = JSON.parse(started.stdout.trim().split('\n').at(-1));
  if (!service.ok) throw new Error(service.error || '服务启动失败');
  const shellToken = fs.readFileSync(path.join(home, '.study-desk/shell.token'), 'utf8').trim();
  const internal = session.fromPartition('persist:study-desk');
  // A stable origin keeps IndexedDB, Blob recordings and settings across port changes.
  internal.protocol.handle('studydesk', async request => {
    const u = new URL(request.url);
    if (u.host !== 'app' || u.username || u.password) return new Response('forbidden', { status: 403 });
    const appPage = u.pathname === '/' || u.pathname === '/index.html';
    const launch = u.searchParams.get('launch');
    if (u.pathname === '/_studydesk/health') return new Response('forbidden', { status: 403 });
    const headers = new Headers(request.headers);
    headers.delete('host'); headers.delete('cookie'); headers.delete('x-studydesk-shell');
    headers.set('origin', new URL(service.url).origin);
    if (request.referrer.startsWith(APP_URL)) headers.set('referer', request.referrer.replace(APP_URL, service.url));
    if (appPage) {
      // Only a one-use URL issued by the main process may receive the capability token.
      if (!launch || !launches.delete(launch)) return new Response('请从应用窗口打开工作台', { status: 403 });
      headers.set('x-studydesk-shell', shellToken);
      u.searchParams.delete('launch');
    }
    const destination = new URL(u.pathname + u.search, service.url);
    const options = { method: request.method, headers, redirect: 'manual' };
    if (!['GET', 'HEAD'].includes(request.method)) options.body = Buffer.from(await request.arrayBuffer());
    const response = await fetch(destination, options);
    const outgoing = new Headers(response.headers);
    if (outgoing.has('content-encoding')) { outgoing.delete('content-encoding'); outgoing.delete('content-length'); }
    outgoing.delete('set-cookie');
    const location = outgoing.get('location');
    if (location) outgoing.set('location', new URL(location, service.url).href.replace(service.url, APP_URL));
    return new Response(response.body, { status: response.status, headers: outgoing });
  });
  internal.setPermissionCheckHandler((contents, permission, origin) => origin === 'studydesk://app' && ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission));
  internal.setPermissionRequestHandler((contents, permission, callback, details) => callback(details.requestingUrl?.startsWith(APP_URL) && ['media', 'display-capture', 'clipboard-read', 'clipboard-sanitized-write'].includes(permission)));
  internal.setDisplayMediaRequestHandler(async (request, callback) => {
    if (request.frame?.url && !request.frame.url.startsWith(APP_URL)) return callback({});
    try {
      const sources = await desktopCapturer.getSources({ types: ['screen'] });
      if (!sources.length) return callback({});
      const choice = await dialog.showMessageBox(mainWindow, { type: 'question', title: '系统声音转写', message: '请选择要共享音频的屏幕', buttons: [...sources.map(s => s.name), '取消'], cancelId: sources.length, defaultId: sources.length });
      if (choice.response >= sources.length) return callback({});
      callback({ video: sources[choice.response], audio: 'loopback' });
    } catch { callback({}); }
  });
  const { uiSocketPath } = await import(pathToFileURL(path.join(root, 'lib/desktop-window.mjs')).href);
  const socket = uiSocketPath(home);
  if (process.platform !== 'win32') { fs.mkdirSync(path.dirname(socket), { recursive: true }); try { fs.unlinkSync(socket); } catch {} }
  control = net.createServer(client => {
    let body = '';
    client.setTimeout(2000, () => client.destroy());
    client.on('error', () => {});
    client.on('data', chunk => { body += chunk; if (body.length > 8192) client.destroy(); });
    client.on('end', () => { try { openPage(JSON.parse(body).url); } catch {} client.end(); });
  });
  await new Promise((resolve, reject) => { control.once('error', reject); control.listen(socket, resolve); });
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    { label: '工作台', submenu: [{ label: '刷新', accelerator: 'CmdOrCtrl+R', click: () => loadDesk(mainWindow) }, { label: '退出', role: 'quit' }] },
    { label: '编辑', submenu: [{ role: 'undo' }, { role: 'redo' }, { type: 'separator' }, { role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { role: 'selectAll' }] },
    { label: '视图', submenu: [{ role: 'resetZoom' }, { role: 'zoomIn' }, { role: 'zoomOut' }, { role: 'togglefullscreen' }] }
  ]));
  mainWindow = makeWindow(true);
  await loadDesk(mainWindow);
  if (smoke) await runSmoke();
}
function makeWindow(internal) {
  const win = new BrowserWindow({ title: '网课学习工作台', width: 1400, height: 920, minWidth: 740, minHeight: 560, show: !smoke, backgroundColor: '#182019', webPreferences: { partition: internal ? 'persist:study-desk' : 'persist:course-pages', nodeIntegration: false, contextIsolation: true, sandbox: true } });
  pages.add(win); win.on('closed', () => pages.delete(win));
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (internal && url.startsWith(APP_URL + 'api/')) win.webContents.downloadURL(url);
    else if (/^https?:\/\//i.test(url)) openPage(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (event, url) => {
    if (internal && !url.startsWith(APP_URL)) { event.preventDefault(); if (/^https?:\/\//i.test(url)) openPage(url); }
    else if (!internal && !/^https?:\/\//i.test(url)) event.preventDefault();
  });
  return win;
}
async function loadDesk(win) {
  const nonce = crypto.randomBytes(24).toString('hex'); launches.add(nonce);
  try { await win.loadURL(APP_URL + '?launch=' + nonce); }
  finally { launches.delete(nonce); }
  await win.webContents.executeJavaScript('history.replaceState(null, "", "/");');
}
function openPage(url) {
  const target = new URL(String(url));
  if (!['http:', 'https:'].includes(target.protocol)) throw new Error('无效链接');
  if (target.origin === new URL(service.url).origin) return loadDesk(mainWindow);
  const win = makeWindow(false); win.loadURL(target.href).catch(() => {});
}
async function runSmoke() {
  const result = await mainWindow.webContents.executeJavaScript(`(async () => {
    const assert = (v,m) => { if (!v) throw new Error(m); };
    assert(document.querySelector('#platformToggle'), 'UI missing');
    assert(document.querySelector('#video'), 'video missing');
    assert(typeof require === 'undefined', 'Node exposed to renderer');
    const response = await fetch('/api/recent-links'); assert(response.ok, 'API blocked');
    const locked = await fetch('/index.html'); assert(locked.status === 403, 'shell token exposed');
    const value = 'windows-中文-' + Date.now(); localStorage.setItem('smoke', value);
    const db = await new Promise((resolve,reject) => { const q = indexedDB.open('smoke-db',1); q.onupgradeneeded=()=>q.result.createObjectStore('kv'); q.onsuccess=()=>resolve(q.result); q.onerror=()=>reject(q.error); });
    await new Promise((resolve,reject)=>{const t=db.transaction('kv','readwrite');t.objectStore('kv').put(new Blob(['recording']), 'audio');t.oncomplete=resolve;t.onerror=()=>reject(t.error);}); db.close();
    return { ui: true, api: true, sandbox: true, stableOrigin: location.origin, localStorage: value };
  })()`);
  // Reload verifies real Chromium storage and fresh shell authorization.
  await loadDesk(mainWindow);
  const stored = await mainWindow.webContents.executeJavaScript(`(async()=>{const db=await new Promise(r=>{const q=indexedDB.open('smoke-db',1);q.onsuccess=()=>r(q.result);});const v=await new Promise(r=>{const t=db.transaction('kv');const q=t.objectStore('kv').get('audio');q.onsuccess=()=>r(q.result);});db.close();return {text:await v.text(),local:localStorage.getItem('smoke')};})()`);
  if (stored.text !== 'recording' || stored.local !== result.localStorage) throw new Error('persistent storage lost');
  await fs.promises.writeFile(process.env.STUDYDESK_SMOKE_RESULT, JSON.stringify({ ok: true, platform: process.platform, version: app.getVersion(), service, ...result, blobAfterReload: true }));
  app.exit(0);
}
