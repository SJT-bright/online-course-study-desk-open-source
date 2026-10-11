import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

const manifestName = 'app-data-location.json';
export function appDataResolver(root) {
  const file = path.join(root, manifestName);
  const entries = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : [];
  return value => {
    if (typeof value !== 'string' || !path.isAbsolute(value)) return value;
    const normalized = path.normalize(value);
    for (const item of entries) if (normalized === item.from || normalized.startsWith(item.from + path.sep)) return item.to + normalized.slice(item.from.length);
    return value;
  };
}
// A fixed path map preserves stored course identities without external symlinks.
export function planAppDataMigration(root, home) {
  const manifest = path.join(root, manifestName);
  if (fs.existsSync(manifest)) {
    const entries = JSON.parse(fs.readFileSync(manifest, 'utf8'));
    for (const item of entries) if (!fs.existsSync(item.to)) throw new Error('已迁移的数据目录缺失：' + item.to);
    return [];
  }
  const id = createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 12);
  const base = path.join(home, '.study-desk', 'app-data', id);
  return ['downloads', 'tools/models', 'tools/bili-cookies.txt'].flatMap(rel => {
    const from = path.join(root, rel), to = path.join(base, rel);
    let stat; try { stat = fs.lstatSync(from); } catch (e) { if (e.code === 'ENOENT') return []; throw e; }
    if (stat.isSymbolicLink()) {
      if (fs.realpathSync(from) !== fs.realpathSync(to)) throw new Error('数据目录指向未知位置，未移动：' + from);
      return [];
    }
    if (fs.existsSync(to)) throw new Error('数据迁移目标已存在，未覆盖：' + to);
    return [{ root, from, to }];
  });
}

export function applyAppDataMigration(plan) {
  const moved = [];
  try {
    for (const item of plan) {
      fs.mkdirSync(path.dirname(item.to), { recursive: true });
      fs.renameSync(item.from, item.to);
      moved.push(item);

    }
    if (moved.length) fs.writeFileSync(path.join(moved[0].root, manifestName), JSON.stringify(moved, null, 2));
    return moved;
  } catch (error) { rollbackAppDataMigration(moved); throw error; }
}

export function rollbackAppDataMigration(moved) {
  if (moved.length) fs.rmSync(path.join(moved[0].root, manifestName), { force: true });
  for (const item of [...moved].reverse()) {
    if (fs.lstatSync(item.from, { throwIfNoEntry: false })?.isSymbolicLink()) fs.unlinkSync(item.from);
    fs.renameSync(item.to, item.from);
  }
}
