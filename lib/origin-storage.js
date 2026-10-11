// Runs only in a local, native-created blank WKWebView. No HTTP page is loaded.
async function pack(value) {
  if (value === undefined) return ['undefined'];
  if (typeof value === 'number' && !Number.isFinite(value)) return ['number', String(value)];
  if (value === null || typeof value !== 'object') return ['value', value];
  if (value instanceof Date) return ['date', value.toISOString()];
  if (value instanceof Blob) {
    const bytes = new Uint8Array(await value.arrayBuffer());
    let binary = '';
    for (let i = 0; i < bytes.length; i += 16384) binary += String.fromCharCode(...bytes.subarray(i, i + 16384));
    return ['blob', btoa(binary), value.type, value instanceof File ? value.name : null,
      value instanceof File ? value.lastModified : null];
  }
  if (value instanceof ArrayBuffer) return ['buffer', Array.from(new Uint8Array(value))];
  if (ArrayBuffer.isView(value)) return ['typed', value.constructor.name, Array.from(new Uint8Array(value.buffer, value.byteOffset, value.byteLength))];
  if (Array.isArray(value)) return ['array', await Promise.all(value.map(pack))];
  if (Object.getPrototypeOf(value) !== Object.prototype) throw new Error('有无法迁移的本地记录，原数据已保留。');
  return ['object', await Promise.all(Object.entries(value).map(async ([k,v]) => [k, await pack(v)]))];
}
function unpack(row) {
  const [kind, value] = row;
  if (kind === 'undefined') return undefined;
  if (kind === 'number') return Number(value);
  if (kind === 'value') return value;
  if (kind === 'date') return new Date(value);
  if (kind === 'blob') {
    const bytes = Uint8Array.from(atob(value), c => c.charCodeAt(0));
    return row[3] === null ? new Blob([bytes], { type: row[2] }) : new File([bytes], row[3], { type: row[2], lastModified: row[4] });
  }
  if (kind === 'buffer') return Uint8Array.from(value).buffer;
  if (kind === 'typed') {
    const buffer = Uint8Array.from(row[2]).buffer;
    const types = { Int8Array, Uint8Array, Uint8ClampedArray, Int16Array, Uint16Array, Int32Array, Uint32Array, Float32Array, Float64Array, DataView };
    if (!types[value]) throw new Error('未知本地数据类型');
    return new types[value](buffer);
  }
  if (kind === 'array') return value.map(unpack);
  if (kind === 'object') return Object.fromEntries(value.map(([k,v]) => [k, unpack(v)]));
  throw new Error('本地数据快照格式无效');
}
const request = indexedDB.open('study-desk', 1);
request.onupgradeneeded = () => request.result.createObjectStore('kv');
const db = await new Promise((ok, no) => { request.onsuccess = () => ok(request.result); request.onerror = () => no(request.error); });
try {
  if (typeof snapshot === 'undefined') {
    const entries = await new Promise((ok, no) => {
      const tx = db.transaction('kv', 'readonly'), store = tx.objectStore('kv');
      const keys = store.getAllKeys(), values = store.getAll();
      tx.oncomplete = () => ok(keys.result.map((key, i) => [key, values.result[i]]));
      tx.onabort = tx.onerror = () => no(tx.error);
    });
    return { version: 1, origin: location.origin,
      entries: await Promise.all(entries.map(async ([k,v]) => [k, await pack(v)])),
      settings: Object.fromEntries(Object.entries(localStorage)) };
  }
  if (snapshot.version !== 1 || !Array.isArray(snapshot.entries)) throw new Error('本地数据快照格式无效');
  const entries = snapshot.entries.map(([k,v]) => [k, unpack(v)]);
  await new Promise((ok, no) => {
    const tx = db.transaction('kv', 'readwrite'), store = tx.objectStore('kv');
    store.clear();
    for (const [k,v] of entries) store.put(v, k);
    tx.oncomplete = ok;
    tx.onabort = tx.onerror = () => no(tx.error);
  });
  localStorage.clear();
  for (const [k,v] of Object.entries(snapshot.settings)) localStorage.setItem(k, v);
  return { restored: entries.length, origin: location.origin };
} finally { db.close(); }
