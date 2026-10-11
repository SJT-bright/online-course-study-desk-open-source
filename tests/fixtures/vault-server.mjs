// Isolated Learning Vault contract fixture. Never reads the user's library.
import http from 'node:http';
const requests = [];
const items = [
  { id: 'fixture-a', title: '镜头语言测试资料', kind: 'note', category: '视频制作', tags: ['镜头'], notes: '这是测试资料', created_at: Date.now() },
  { id: 'fixture-b', title: '数学测试资料', kind: 'note', category: '数学', tags: [], notes: '第二条测试资料', created_at: Date.now() },
];
const server = http.createServer(async (req, res) => {
  let raw = ''; for await (const chunk of req) raw += chunk;
  const url = new URL(req.url, 'http://127.0.0.1');
  const body = raw ? JSON.parse(raw) : {};
  if (url.pathname !== '/observed') requests.push({ path: url.pathname, query: Object.fromEntries(url.searchParams), body });
  let result = { ok: true };
  if (url.pathname === '/ping') result = { ok: true, version: 'test', items: items.length };
  else if (url.pathname === '/categories') result = { categories: [{ name: '视频制作', count: 1 }, { name: '数学', count: 1 }] };
  else if (['/recent', '/search'].includes(url.pathname)) {
    const category = url.searchParams.get('category'), q = url.searchParams.get('q');
    const filtered = items.filter(it => (!category || it.category === category) && (!q || it.title.includes(q)));
    result = { items: filtered, total: filtered.length };
  } else if (url.pathname === '/ingest') result = { ok: true, id: 'fixture-new', category: '测试', title: '测试收录' };
  else if (url.pathname === '/observed') result = requests;
  res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(result));
});
server.listen(Number(process.env.MOCK_VAULT_PORT) || 18795, '127.0.0.1', () => console.log('Isolated vault fixture listening'));
