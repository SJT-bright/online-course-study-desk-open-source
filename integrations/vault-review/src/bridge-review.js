/**
 * 本机桥复习接口的纯函数。SM-2 只调用 deps 里的 schedule / dueCards / newCard
 * （生产环境传入 src/srs.js），这里不另写一套调度。
 * 返回 { status, body }；路径不属复习接口时返回 null。
 */

function plainBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return {};
  return body;
}

// 与 ipc srs:due 相同：srsDailyLimit 缺省 5，至少 1
function dailyLimit(raw) {
  return Math.max(1, parseInt(raw, 10) || 5);
}

function clipStr(v, max) {
  if (typeof v !== 'string' || !v) return null;
  return v.slice(0, max);
}

// 只留白名单字段。t 必须已是有限非负数字；空串与非法 mark 丢掉。
function sanitizeCardSource(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const out = {};
  const app = clipStr(raw.app, 40);
  const videoKey = clipStr(raw.videoKey, 500);
  const noteName = clipStr(raw.noteName, 160);
  const quote = clipStr(raw.quote, 300);
  const dedupe = clipStr(raw.dedupe, 180);
  if (app) out.app = app;
  if (videoKey) out.videoKey = videoKey;
  if (noteName) out.noteName = noteName;
  if (quote) out.quote = quote;
  if (dedupe && dedupe.trim()) out.dedupe = dedupe;
  if (typeof raw.t === 'number' && Number.isFinite(raw.t) && raw.t >= 0) out.t = raw.t;
  if (raw.mark === 'key' || raw.mark === 'miss' || raw.mark === 'reuse') out.mark = raw.mark;
  return Object.keys(out).length ? out : null;
}

function itemTitleOf(card, deps) {
  if (typeof deps.itemTitle === 'function') {
    const t = deps.itemTitle(card ? card.itemId : null);
    return t == null ? '' : String(t);
  }
  if (typeof deps.getItem === 'function' && card && card.itemId) {
    const it = deps.getItem(card.itemId);
    return it && it.title ? String(it.title) : '';
  }
  return '';
}

function projectDueCard(card, deps) {
  return {
    id: card.id,
    front: card.front,
    back: card.back,
    due: card.due,
    interval: card.interval,
    reps: card.reps,
    lapses: card.lapses,
    itemId: card.itemId == null ? null : card.itemId,
    kind: card.kind == null ? null : card.kind,
    source: card.source == null ? null : card.source,
    itemTitle: itemTitleOf(card, deps),
  };
}

function liveCard(c) {
  return !!(c && !c.deleted && !c.trashed);
}

function handleDue(deps) {
  const now = Number.isFinite(deps.now) ? deps.now : Date.now();
  const limit = dailyLimit(deps.limit);
  const total = deps.dueCards(deps.cards, now, 9999).length;
  const shown = deps.dueCards(deps.cards, now, limit);
  return {
    status: 200,
    body: {
      ok: true,
      total,
      limit,
      items: shown.map(c => projectDueCard(c, deps)),
    },
  };
}

function handleGrade(body, deps) {
  const b = plainBody(body);
  const grade = b.grade;
  if (![1, 2, 3].includes(grade)) {
    return { status: 400, body: { ok: false, error: '评分只允许 1、2、3' } };
  }
  const card = deps.cards.find(c => c && c.id === b.cardId);
  if (!card) return { status: 404, body: { ok: false, error: '卡片不存在' } };
  // 两参数调用，与 ipc srs:grade 的 srs.schedule(card, g) 一致；非法分已在上面拒绝
  Object.assign(card, deps.schedule(card, grade));
  deps.save();
  deps.addEvent({ type: 'srs_review', cardId: b.cardId, grade, itemId: card.itemId, interval: card.interval });
  if (typeof deps.pushSrsCount === 'function') deps.pushSrsCount();
  return {
    status: 200,
    body: { ok: true, card: { ...card, source: card.source == null ? null : card.source } },
  };
}

function handleCard(body, deps) {
  const b = plainBody(body);
  const front = String(b.front || '').trim();
  if (!front) return { status: 400, body: { error: '卡面是空的' } };
  const back = String(b.back || '').trim();
  const srcId = String(b.sourceItemId || '') || null;
  if (srcId) {
    const srcIt = typeof deps.getItem === 'function' ? deps.getItem(srcId) : null;
    if (!srcIt || srcIt.trashed) return { status: 404, body: { error: 'not found' } };
  }
  const source = sanitizeCardSource(b.source);
  // 长度限制只走 newCard，不在这里另写一套截断
  const shaped = deps.newCard({ itemId: srcId, kind: 'manual', front, back });
  if (source) shaped.source = source;
  const dedupeKey = source && source.dedupe;
  if (dedupeKey) {
    const existing = deps.cards.find(c => liveCard(c) && c.source && c.source.dedupe === dedupeKey);
    if (existing) {
      existing.front = shaped.front;
      existing.back = shaped.back;
      existing.source = shaped.source;
      deps.save();
      return { status: 200, body: { ok: true, id: existing.id, deduped: true } };
    }
  }
  deps.cards.push(shaped);
  deps.save();
  return { status: 200, body: { ok: true, id: shaped.id } };
}

function handleBridgeReview(reqPath, method, body, deps) {
  const d = deps || {};
  const path = String(reqPath || '');
  const m = String(method || '');
  const hit = (m === 'GET' && path === '/review/due')
    || (m === 'POST' && path === '/review/grade')
    || (m === 'POST' && path === '/card');
  if (!hit) return null;
  if (!Array.isArray(d.cards)) return { status: 500, body: { ok: false, error: '复习依赖未就绪' } };
  if (m === 'GET' && path === '/review/due') return handleDue(d);
  if (m === 'POST' && path === '/review/grade') return handleGrade(body, d);
  return handleCard(body, d);
}

module.exports = { handleBridgeReview, sanitizeCardSource };
