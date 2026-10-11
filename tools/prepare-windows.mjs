import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
const dir = path.resolve('.windows-runtime');
fs.mkdirSync(dir, { recursive: true });
const base = 'https://nodejs.org/download/release/v24.21.0/';
async function get(url) { const r = await fetch(url, { signal: AbortSignal.timeout(120000) }); if (!r.ok) throw new Error(`${url}: ${r.status}`); return Buffer.from(await r.arrayBuffer()); }
const sums = (await get(base + 'SHASUMS256.txt')).toString();
const line = sums.split('\n').find(s => s.trim().endsWith(' win-x64/node.exe'));
if (!line) throw new Error('Node Windows checksum missing');
const expected = line.split(/\s+/)[0];
const binary = await get(base + 'win-x64/node.exe');
if (crypto.createHash('sha256').update(binary).digest('hex') !== expected) throw new Error('Node checksum mismatch');
fs.writeFileSync(path.join(dir, 'node.exe'), binary);
fs.writeFileSync(path.join(dir, 'NODE-LICENSE.txt'), await get('https://raw.githubusercontent.com/nodejs/node/v24.21.0/LICENSE'));
fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({ source: base, sha256: expected, architecture: 'x64', downloadedAt: new Date().toISOString() }, null, 2));
console.log('Verified Node.js 24 Windows x64 runtime');
