/**
 * 工作台自己的复习队列。
 * 默认使用随源码分发的本地规则；STUDYDESK_SRS 可显式指定外部兼容规则。
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);
const DEFAULT_SRS = new URL("./srs.cjs", import.meta.url);

export function loadSrs(explicit) {
  const file = explicit || process.env.STUDYDESK_SRS || DEFAULT_SRS;
  if (!fs.existsSync(file)) {
    const err = new Error("找不到学习资产库的复习规则：" + (file || DEFAULT_SRS));
    err.status = 500;
    throw err;
  }
  return require(file instanceof URL ? fileURLToPath(file) : file);
}

function clip(v, max) {
  if (typeof v !== "string" || !v) return "";
  return v.slice(0, max);
}

export function cleanSource(raw) {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out = {};
  const app = clip(raw.app, 40);
  const videoKey = clip(String(raw.videoKey || ""), 500);
  const noteName = clip(raw.noteName, 160);
  const quote = clip(raw.quote, 300);
  const dedupe = clip(String(raw.dedupe || ""), 180).trim();
  if (app) out.app = app;
  if (videoKey) out.videoKey = videoKey;
  if (noteName) out.noteName = noteName;
  if (quote) out.quote = quote;
  if (dedupe) out.dedupe = dedupe;
  const t = Number(raw.t);
  if (raw.t != null && raw.t !== "" && Number.isFinite(t) && t >= 0) out.t = t;
  if (raw.mark === "key" || raw.mark === "miss" || raw.mark === "reuse") out.mark = raw.mark;
  return Object.keys(out).length ? out : null;
}

function readCards(file) {
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(data.cards) ? data.cards : [];
  } catch {
    return [];
  }
}

function writeCards(file, cards) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify({ cards }), "utf8");
  fs.renameSync(tmp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function openReviewQueue(file, srs = loadSrs()) {
  let chain = Promise.resolve();
  const use = fn => {
    const run = chain.then(fn);
    chain = run.then(() => {}, () => {});
    return run;
  };
  const project = card => ({
    id: card.id,
    front: card.front,
    back: card.back,
    due: card.due,
    interval: card.interval,
    reps: card.reps,
    lapses: card.lapses,
    itemId: card.itemId || null,
    kind: card.kind || null,
    source: card.source || null,
    itemTitle: card.source?.noteName || "",
  });

  return {
    has(id) {
      return readCards(file).some(c => c && c.id === id && !c.suspended);
    },
    due(now = Date.now()) {
      const cards = readCards(file);
      const limit = 20;
      const all = srs.dueCards(cards, now, 9999);
      return {
        ok: true,
        local: true,
        total: all.length,
        limit,
        items: srs.dueCards(cards, now, limit).map(project),
      };
    },
    save(body, now = Date.now()) {
      const front = String(body?.front || "").trim();
      if (!front) {
        const err = new Error("卡面是空的");
        err.status = 400;
        throw err;
      }
      const back = String(body?.back || "").trim();
      const source = cleanSource(body?.source);
      return use(() => {
        const cards = readCards(file);
        const shaped = srs.newCard({ itemId: null, kind: "manual", front, back });
        if (source) shaped.source = source;
        /* 课堂上刚标的句子当天就能复习。资产库自己的新卡仍是明天，这里只改工作台这份。 */
        if (source?.app === "studydesk") shaped.due = srs.anchor4am(now);
        const dedupe = source?.dedupe;
        if (dedupe) {
          const prev = cards.find(c => c && !c.suspended && c.source?.dedupe === dedupe);
          if (prev) {
            prev.front = shaped.front;
            prev.back = shaped.back;
            prev.source = shaped.source;
            writeCards(file, cards);
            return { ...prev, deduped: true };
          }
        }
        cards.push(shaped);
        writeCards(file, cards);
        return shaped;
      });
    },
    grade(cardId, grade, now = Date.now()) {
      if (![1, 2, 3].includes(grade)) {
        const err = new Error("评分只允许 1、2、3");
        err.status = 400;
        throw err;
      }
      return use(() => {
        const cards = readCards(file);
        const card = cards.find(c => c && c.id === cardId);
        if (!card) {
          const err = new Error("卡片不存在");
          err.status = 404;
          throw err;
        }
        Object.assign(card, srs.schedule(card, grade, now));
        writeCards(file, cards);
        return { ok: true, local: true, card: project(card) };
      });
    },
  };
}
