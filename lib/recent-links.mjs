import fs from 'node:fs';
import path from 'node:path';

export function cleanRecentLink(input) {
  const url = new URL(String(input.url || ''));
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('请输入有效的网页链接');
  if (url.hostname === '127.0.0.1' && url.pathname.startsWith('/api/')) throw new Error('请保存原始课程链接');
  for (const name of [...url.searchParams.keys()]) if (/^(sd_token|access_token|refresh_token|password|api_key)$/i.test(name)) url.searchParams.delete(name);
  let key = url.href;
  let platform = String(input.platform || 'other').slice(0, 40);
  const bv = url.pathname.match(/\/video\/(BV[a-zA-Z0-9]+)/)?.[1];
  if (/(^|\.)bilibili\.com$/i.test(url.hostname) && bv) {
    const part = Math.max(1, Number.parseInt(url.searchParams.get('p'), 10) || 1);
    key = `bili:${bv}:${part}`; platform = 'bili';
    const seek = url.searchParams.get('t');
    url.href = `https://www.bilibili.com/video/${bv}/?p=${part}`;
    if (seek && Number.isFinite(Number(seek)) && Number(seek) >= 0) url.searchParams.set('t', seek);
  }
  if (url.href.length > 4000) throw new Error('链接过长');
  return { key, url: url.href, platform, name: String(input.name || url.hostname).trim().slice(0, 240) || url.hostname };
}

export function openRecentLinks(file) {
  function read() {
    if (!fs.existsSync(file)) return { limit: 20, items: [] };
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Number.isInteger(data.limit) || data.limit < 1 || data.limit > 50 || !Array.isArray(data.items)) throw new Error('最近链接数据损坏，原文件已保留');
    return data;
  }
  function write(data) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temp = file + '.tmp-' + process.pid;
    try {
      fs.writeFileSync(temp, JSON.stringify(data, null, 2), { mode: 0o600 });
      fs.renameSync(temp, file);
    } finally { if (fs.existsSync(temp)) fs.unlinkSync(temp); }
    return data;
  }
  return {
    list(platform = '') { const data = read(); return { ...data, items: data.items.filter(i => !platform || i.platform === platform) }; },
    add(input) {
      const link = cleanRecentLink(input), data = read();
      return write({ ...data, items: [{ ...link, lastOpenedAt: Date.now() }, ...data.items.filter(i => i.key !== link.key)].slice(0, data.limit) });
    },
    setLimit(limit) {
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('保留上限须为 1–50 的整数');
      const data = read(); return write({ limit, items: data.items.slice(0, limit) });
    },
    remove(key) { const data = read(); return write({ ...data, items: data.items.filter(i => i.key !== key) }); },
  };
}
