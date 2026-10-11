/**
 * 联合搜索与资产库复习代理。隔离 STUDYDESK_HOME / 转写目录 / 随机端口，不碰 8790。
 * 运行：node tests/search-review-proxy.test.mjs
 */
import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import net from "node:net";
import http from "node:http";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { once } from "node:events";
import { fileURLToPath } from "node:url";
import { setTimeout as delay } from "node:timers/promises";

const serverFile = fileURLToPath(new URL("../server.mjs", import.meta.url));

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

async function allocPort() {
  for (;;) {
    const p = await freePort();
    if (p !== 8790 && p !== 8791) return p;
  }
}

async function stopChild(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const done = await Promise.race([exited.then(() => true), delay(2000).then(() => false)]);
  if (!done && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await Promise.race([once(child, "exit"), delay(1000)]);
  }
}

async function startDesk(vaultPort) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sd-search-"));
  const port = await allocPort();
  const child = spawn(process.execPath, [serverFile], {
    env: {
      ...process.env,
      STUDYDESK_HOME: dir,
      STUDYDESK_TRANSCRIPTS_DIR: path.join(dir, "transcripts"),
      STUDYDESK_PORT: String(port),
      STUDYDESK_VAULT_PORT: String(vaultPort),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  const take = d => { log += d; if (log.length > 8000) log = log.slice(-8000); };
  child.stdout.on("data", take);
  child.stderr.on("data", take);
  const origin = `http://127.0.0.1:${port}`;
  let token = "";
  try {
    for (let i = 0; i < 80 && !token; i++) {
      try {
        const r = await fetch(origin + "/api/version");
        if (r.status === 403 || r.status === 200) {
          const html = await (await fetch(origin + "/")).text();
          token = (html.match(/const __SD_TOKEN = "([0-9a-f]+)"/) || [])[1] || "";
        }
      } catch { /* 尚未监听 */ }
      if (!token) await delay(50);
    }
    if (!token) throw new Error("isolated server did not start:\n" + log.slice(-1500));
  } catch (e) {
    await stopChild(child);
    fs.rmSync(dir, { recursive: true, force: true });
    throw e;
  }
  const withToken = route => {
    const u = new URL(route, origin);
    u.searchParams.set("sd_token", token);
    return u.toString();
  };
  return {
    origin,
    withToken,
    log: () => log,
    async stop() {
      await stopChild(child);
      fs.rmSync(dir, { recursive: true, force: true });
    },
  };
}

function startMockVault(port) {
  const seen = [];
  const server = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const raw = Buffer.concat(chunks).toString("utf8");
    const u = new URL(req.url, "http://127.0.0.1");
    seen.push({ method: req.method, path: u.pathname, search: u.search, raw, type: req.headers["content-type"] || "" });
    let body;
    if (u.pathname === "/review/due") body = { ok: true, cards: [{ id: "card-9" }] };
    else if (u.pathname === "/review/grade") body = { ok: true };
    else if (u.pathname === "/search") {
      body = {
        total: 3,
        items: [
          { id: "v1", title: "资产标题", kind: "note", category: "数学", summary: "<b>" + "摘".repeat(100) + "</b>", notes: "不应该出现的笔记正文" },
          { id: "v2", title: "只有笔记", kind: "file", category: "语文", summary: "", notes: "纯文本笔记内容" },
          { id: "v3", title: "", kind: "", category: "", summary: "", notes: "" },
        ],
      };
    } else {
      res.writeHead(404, { "content-type": "application/json" });
      res.end(JSON.stringify({ error: "no" }));
      return;
    }
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve({ server, seen }));
  });
}

test("search and review proxy when the vault is down", { timeout: 30000 }, async () => {
  const vaultPort = await allocPort();
  const desk = await startDesk(vaultPort);
  const getSearch = async q => {
    const res = await fetch(desk.withToken("/api/search?q=" + encodeURIComponent(q)));
    const body = await res.json();
    return { status: res.status, body };
  };
  try {
    const bareSearch = await fetch(desk.origin + "/api/search?q=x");
    assert.equal(bareSearch.status, 403);
    assert.equal((await bareSearch.json()).error, "forbidden");
    const bareDue = await fetch(desk.origin + "/api/vault/due");
    assert.equal(bareDue.status, 403);
    assert.equal((await bareDue.json()).error, "forbidden");
    const bareGrade = await fetch(desk.origin + "/api/vault/grade", {
      method: "POST", headers: { "content-type": "application/json" }, body: "{}",
    });
    assert.equal(bareGrade.status, 403);

    const emptyRes = await fetch(desk.withToken("/api/search?q="));
    assert.equal(emptyRes.status, 200);
    const empty = await emptyRes.json();
    assert.equal(empty.ok, true);
    assert.equal(empty.notes.length, 0);
    assert.equal(empty.transcripts.length, 0);
    assert.equal(empty.vault.length, 0);
    assert.equal(Object.hasOwn(empty, "notesError"), false);
    assert.equal(Object.hasOwn(empty, "vaultError"), false);

    const blank = await getSearch("   ");
    assert.equal(blank.status, 200);
    assert.equal(blank.body.notes.length, 0);
    assert.equal(blank.body.transcripts.length, 0);
    assert.equal(blank.body.vault.length, 0);
    assert.equal(Object.hasOwn(blank.body, "vaultError"), false);

    const none = await getSearch("没有任何资料xyz");
    assert.equal(none.status, 200);
    assert.equal(none.body.ok, true);
    assert.equal(none.body.notes.length, 0);
    assert.equal(none.body.transcripts.length, 0);
    assert.equal(none.body.vault.length, 0);
    assert.match(none.body.vaultError, /学习资产库/);

    const tooLong = await getSearch("a".repeat(201));
    assert.equal(tooLong.status, 400);

    const main = {
      id: "search-lesson-1",
      startedAt: 1700000000000,
      title: "课堂记录",
      courseName: "高等数学",
      source: "file",
      sourceLabel: "隔离测试",
      text: "全文里也有二重积分",
      status: "done",
      lines: [
        { text: "开头没有关键词", t0: 0, t1: 1000 },
        { text: "再计算二重积分的区域", t0: 12500, t1: 18000 },
      ],
    };
    const bodyOnly = {
      id: "body-only",
      startedAt: 1500000000000,
      title: "正文时间",
      courseName: "语文",
      text: "只有正文里的孤词qwerty",
      lines: [{ text: "这一句没有那个词", t0: 9000, t1: 9500 }],
    };
    const extras = Array.from({ length: 22 }, (_, i) => ({
      id: "extra-" + i,
      startedAt: 1600000000000 + i,
      title: "补充" + i,
      text: "二重积分补充",
      lines: [{ text: "二重积分补充句", t0: 2000, t1: 2500 }],
    }));
    const restored = await (await fetch(desk.withToken("/api/transcripts/restore"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ records: [main, bodyOnly, ...extras] }),
    })).json();
    assert.equal(restored.added, 24);
    assert.equal(restored.skipped, 0);

    const save = async (rec) => {
      const res = await fetch(desk.withToken("/api/notes/save"), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(rec),
      });
      assert.equal(res.status, 200);
      const body = await res.json();
      assert.equal(body.ok, true);
    };
    await save({
      key: "note-search-1",
      name: "课堂笔记",
      courseName: "高等数学",
      tags: ["冷门标签zz"],
      html: "<p>" + "前".repeat(100) + "二重积分的几何意义" + "后".repeat(100) + "</p>",
      savedAt: 1700000001000,
    });
    await save({
      key: "note-pct",
      name: "百分号",
      html: "<p>完成度是 100%_ok 结束</p>",
      savedAt: 1700000002000,
    });
    await save({
      key: "note-plain",
      name: "普通笔记",
      html: "<p>普通正文没有任何符号</p>",
      savedAt: 1700000003000,
    });

    const hit = await getSearch("二重积分");
    assert.equal(hit.status, 200);
    assert.equal(hit.body.ok, true);
    assert.equal(hit.body.transcripts.length, 20);
    assert.equal(hit.body.vault.length, 0);
    assert.match(hit.body.vaultError, /学习资产库/);
    assert.equal(hit.body.notesError, undefined);
    const tr = hit.body.transcripts.find(t => t.id === "search-lesson-1");
    assert.ok(tr);
    assert.equal(tr.title, "课堂记录");
    assert.equal(tr.courseName, "高等数学");
    assert.equal(tr.t, 12.5);
    assert.equal(typeof tr.t, "number");
    assert.match(tr.snippet, /二重积分/);
    assert.equal(tr.snippet.includes("<"), false);
    assert.equal(tr.snippet.length <= 80, true);
    const note = hit.body.notes.find(n => n.key === "note-search-1");
    assert.ok(note);
    assert.equal(note.name, "课堂笔记");
    assert.equal(note.courseName, "高等数学");
    assert.equal(note.savedAt, 1700000001000);
    assert.equal(note.snippet.length, 80);
    assert.match(note.snippet, /二重积分/);
    assert.match(note.snippet, /几何/);
    assert.notEqual(note.snippet, "前".repeat(80));
    assert.equal(Object.hasOwn(note, "html"), false);
    assert.equal(Object.hasOwn(note, "text"), false);

    const timed = await getSearch("孤词qwerty");
    const bodyHit = timed.body.transcripts.find(t => t.id === "body-only");
    assert.ok(bodyHit);
    assert.equal(bodyHit.t, null);
    assert.match(bodyHit.snippet, /孤词qwerty/);
    assert.equal(bodyHit.courseName, "语文");

    const both = await getSearch("二重积分 课堂");
    assert.ok(both.body.notes.some(n => n.key === "note-search-1"));
    assert.deepEqual(both.body.transcripts.map(t => t.id), ["search-lesson-1"]);
    const miss = await getSearch("二重积分 不存在词xyz");
    assert.equal(miss.body.notes.length, 0);
    assert.equal(miss.body.transcripts.length, 0);

    const byCourse = await getSearch("高等数学");
    assert.ok(byCourse.body.notes.some(n => n.key === "note-search-1"));
    assert.equal(byCourse.body.transcripts.length, 0);
    const byTag = await getSearch("冷门标签zz");
    assert.ok(byTag.body.notes.some(n => n.key === "note-search-1"));

    const like = await getSearch("%_");
    assert.ok(like.body.notes.some(n => n.key === "note-pct"));
    assert.equal(like.body.notes.some(n => n.key === "note-plain"), false);
    assert.equal(like.body.notes.some(n => n.key === "note-search-1"), false);

    const due = await fetch(desk.withToken("/api/vault/due"));
    assert.equal(due.status, 200);
    const dueBody = await due.json();
    assert.equal(dueBody.ok, true);
    assert.equal(dueBody.local, true);
    assert.deepEqual(dueBody.items, []);
    const made = await fetch(desk.withToken("/api/vault/card"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        front: "【没懂】这个转场为什么有效",
        back: "这个转场为什么有效",
        source: { app: "studydesk", videoKey: "srv:/tmp/lesson.mp4", t: 12.5, mark: "miss", noteName: "分镜课", quote: "这个转场为什么有效", dedupe: "srv:/tmp/lesson.mp4|miss|这个转场" },
      }),
    });
    assert.equal(made.status, 200);
    const madeBody = await made.json();
    assert.equal(madeBody.ok, true);
    assert.equal(madeBody.local, true);
    const again = await fetch(desk.withToken("/api/vault/due"));
    const queued = await again.json();
    assert.equal(queued.items.length, 1);
    assert.equal(queued.items[0].source.t, 12.5);
    assert.equal(queued.items[0].source.videoKey, "srv:/tmp/lesson.mp4");
    const graded = await fetch(desk.withToken("/api/vault/grade"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ cardId: queued.items[0].id, grade: 1 }),
    });
    assert.equal(graded.status, 200);
    const gradedBody = await graded.json();
    assert.equal(gradedBody.ok, true);
    assert.equal(gradedBody.card.interval, 1);
    assert.equal(gradedBody.card.source.mark, "miss");
    const gone = await (await fetch(desk.withToken("/api/vault/due"))).json();
    assert.equal(gone.items.length, 0);
    const grade = await fetch(desk.withToken("/api/vault/grade"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{not-json",
    });
    assert.equal(grade.status, 502);
    const gradeBody = await grade.json();
    assert.equal(typeof gradeBody.error, "string");
    assert.match(gradeBody.error, /学习资产库/);
  } finally {
    await desk.stop();
  }
});

test("review proxy forwards and search maps vault items", { timeout: 30000 }, async () => {
  const vaultPort = await allocPort();
  const mock = await startMockVault(vaultPort);
  const desk = await startDesk(vaultPort);
  try {
    const due = await fetch(desk.withToken("/api/vault/due?deck=today"));
    assert.equal(due.status, 200);
    assert.deepEqual(await due.json(), { ok: true, cards: [{ id: "card-9" }] });
    const dueReq = mock.seen.find(s => s.path === "/review/due");
    assert.ok(dueReq);
    assert.equal(dueReq.method, "GET");
    assert.match(dueReq.search, /(?:^|\?|&)deck=today(?:&|$)/);
    assert.equal(dueReq.search.includes("sd_token"), false);

    const payload = '{"id": "card-9", "grade": 4}';
    const grade = await fetch(desk.withToken("/api/vault/grade"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: payload,
    });
    assert.equal(grade.status, 200);
    assert.deepEqual(await grade.json(), { ok: true });
    const gradeReq = mock.seen.find(s => s.path === "/review/grade");
    assert.ok(gradeReq);
    assert.equal(gradeReq.method, "POST");
    assert.equal(gradeReq.raw, payload);
    assert.match(gradeReq.type, /application\/json/);

    const res = await fetch(desk.withToken("/api/search?q=" + encodeURIComponent("资产")));
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.notes.length, 0);
    assert.equal(body.transcripts.length, 0);
    assert.equal(body.vaultError, undefined);
    assert.deepEqual(body.vault.map(v => Object.keys(v).sort()), [
      ["category", "id", "kind", "snippet", "title"],
      ["category", "id", "kind", "snippet", "title"],
      ["category", "id", "kind", "snippet", "title"],
    ]);
    assert.deepEqual(body.vault[0], {
      id: "v1", title: "资产标题", kind: "note", category: "数学", snippet: "摘".repeat(80),
    });
    assert.equal(body.vault[1].snippet, "纯文本笔记内容");
    assert.deepEqual(body.vault[2], { id: "v3", title: "", kind: "", category: "", snippet: "" });
    const searchReq = mock.seen.find(s => s.path === "/search");
    const q = new URL("http://127.0.0.1" + searchReq.path + searchReq.search);
    assert.equal(q.searchParams.get("q"), "资产");
    assert.equal(q.searchParams.get("limit"), "20");
    assert.equal(q.searchParams.get("sd_token"), null);
  } finally {
    await desk.stop();
    await new Promise((resolve, reject) => mock.server.close(err => err ? reject(err) : resolve()));
  }
});
