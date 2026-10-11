#!/usr/bin/env node
/**
 * 复习桥纯函数自检：不启动 Electron，不读 srs-cards.json。
 * 运行：node scripts/bridge-review-check.js
 */
'use strict';
const fs = require('fs');
const path = require('path');
const assert = require('assert/strict');

const ROOT = path.resolve(__dirname, '..');
const srs = require(path.join(ROOT, 'src', 'srs.js'));
const { handleBridgeReview } = require(path.join(ROOT, 'src', 'bridge-review.js'));

const DUE_KEYS = ['id', 'front', 'back', 'due', 'interval', 'reps', 'lapses', 'itemId', 'kind', 'source', 'itemTitle'];
let passed = 0;
function check(name, fn) {
  fn();
  passed += 1;
  console.log('  ✓ ' + name);
}

function makeDeps(cards, opt = {}) {
  const events = [];
  const saves = [];
  const pushes = [];
  const scheduleArgs = [];
  const dueLimits = [];
  const newCardSpecs = [];
  const d = {
    cards,
    schedule: function (card, grade) {
      scheduleArgs.push({ grade, argc: arguments.length });
      return srs.schedule(card, grade, opt.scheduleNow);
    },
    dueCards: (list, now, limit) => {
      dueLimits.push(limit);
      return srs.dueCards(list, now, limit);
    },
    newCard: (spec) => {
      newCardSpecs.push(spec);
      return srs.newCard(spec);
    },
    save: () => { saves.push(1); },
    addEvent: (ev) => { events.push(ev); },
    pushSrsCount: () => { pushes.push(1); },
    limit: Object.prototype.hasOwnProperty.call(opt, 'limit') ? opt.limit : undefined,
    now: opt.now,
    getItem: opt.getItem,
    itemTitle: opt.itemTitle,
  };
  return { d, events, saves, pushes, scheduleArgs, dueLimits, newCardSpecs };
}

function baseCard(over) {
  return {
    id: 'c1', front: '问', back: '答', due: 1, interval: 4, reps: 2, lapses: 0,
    itemId: 'item-1', kind: 'manual', suspended: false, ease: 1.234,
    notes: 'NO_LEAK_CARD',
    source: { dedupe: 'keep', app: 'study' },
    ...over,
  };
}

check('到期队列：上限、总数、字段，且不泄漏整库', () => {
  const now = Date.now();
  const cards = [];
  for (let i = 0; i < 6; i++) {
    cards.push(baseCard({
      id: 'd' + i,
      due: 1000 + i,
      itemId: i === 0 ? 'item-1' : null,
      source: i === 0 ? { dedupe: 'keep', app: 'study' } : undefined,
      ease: 1.234,
      notes: 'NO_LEAK_CARD',
    }));
  }
  cards.push(baseCard({ id: 'paused', due: 1, suspended: true, itemId: 'secret-item' }));
  cards.push(baseCard({ id: 'future', due: now + 10 * 86400000, itemId: 'future-item', front: '还没到期' }));
  const { d, dueLimits } = makeDeps(cards, {
    now,
    limit: undefined,
    getItem: (id) => {
      if (id === 'item-1') return { id, title: '可见标题', notes: 'NO_LEAK_STORE', text: '全文不该出现' };
      if (id === 'future-item') return { id, title: '未来标题' };
      if (id === 'secret-item') return { id, title: '暂停标题' };
      return null;
    },
  });
  const orderBefore = cards.map(c => c.id).join(',');
  const res = handleBridgeReview('/review/due', 'GET', null, d);
  assert.equal(res.status, 200);
  assert.equal(res.body.ok, true);
  assert.equal(res.body.total, 6);
  assert.equal(res.body.limit, 5);
  assert.equal(res.body.items.length, 5);
  assert.deepEqual(dueLimits, [9999, 5]);
  assert.deepEqual(res.body.items.map(c => c.id), ['d0', 'd1', 'd2', 'd3', 'd4']);
  assert.deepEqual(Object.keys(res.body.items[0]), DUE_KEYS);
  assert.equal(res.body.items[0].itemTitle, '可见标题');
  assert.equal(res.body.items[0].source.app, 'study');
  assert.equal(res.body.items[1].source, null);
  assert.equal(res.body.items[1].itemTitle, '');
  assert.equal(res.body.items[1].itemId, null);
  const blob = JSON.stringify(res.body);
  assert.equal(blob.includes('NO_LEAK_STORE'), false);
  assert.equal(blob.includes('NO_LEAK_CARD'), false);
  assert.equal(blob.includes('全文不该出现'), false);
  assert.equal(blob.includes('1.234'), false);
  assert.equal(blob.includes('未来标题'), false);
  assert.equal(blob.includes('暂停标题'), false);
  assert.equal(blob.includes('还没到期'), false);
  assert.equal(cards.map(c => c.id).join(','), orderBefore);

  const one = handleBridgeReview('/review/due', 'GET', null, makeDeps(cards, { now, limit: 1, getItem: () => null }).d);
  assert.equal(one.body.limit, 1);
  assert.equal(one.body.total, 6);
  assert.equal(one.body.items.length, 1);
  assert.equal(one.body.items[0].id, 'd0');

  const zero = handleBridgeReview('/review/due', 'GET', null, makeDeps(cards, { now, limit: 0, getItem: () => null }).d);
  assert.equal(zero.body.limit, 5);
  assert.equal(zero.body.items.length, 5);

  const neg = handleBridgeReview('/review/due', 'GET', null, makeDeps(cards, { now, limit: -4, getItem: () => null }).d);
  assert.equal(neg.body.limit, 1);
  assert.equal(neg.body.items.length, 1);
});

check('评分：只接受 1/2/3，走注入的 schedule，并记 srs_review', () => {
  const scheduleNow = Date.UTC(2026, 8, 27, 8, 0, 0);
  const card = baseCard({ id: 'g1' });
  const snap = JSON.parse(JSON.stringify(card));
  const bag = makeDeps([card], { scheduleNow });
  for (const bad of [0, 4, -1, 1.5, '1', '3', null, true, undefined]) {
    const res = handleBridgeReview('/review/grade', 'POST', { cardId: 'g1', grade: bad }, bag.d);
    assert.equal(res.status, 400, 'grade ' + String(bad));
    assert.deepEqual(res.body, { ok: false, error: '评分只允许 1、2、3' });
  }
  assert.equal(bag.saves.length, 0);
  assert.equal(bag.pushes.length, 0);
  assert.equal(bag.events.length, 0);
  assert.equal(bag.scheduleArgs.length, 0);
  assert.deepEqual(JSON.parse(JSON.stringify(card)), snap);

  const missing = handleBridgeReview('/review/grade', 'POST', { cardId: 'nope', grade: 3 }, bag.d);
  assert.equal(missing.status, 404);
  assert.deepEqual(missing.body, { ok: false, error: '卡片不存在' });
  assert.equal(bag.saves.length, 0);

  const ok = handleBridgeReview('/review/grade', 'POST', { cardId: 'g1', grade: 2 }, bag.d);
  const patch = srs.schedule(snap, 2, scheduleNow);
  assert.equal(ok.status, 200);
  assert.equal(ok.body.ok, true);
  assert.equal(bag.scheduleArgs.length, 1);
  assert.equal(bag.scheduleArgs[0].grade, 2);
  assert.equal(bag.scheduleArgs[0].argc, 2);
  assert.equal(card.interval, patch.interval);
  assert.equal(card.ease, patch.ease);
  assert.equal(card.reps, patch.reps);
  assert.equal(card.lapses, patch.lapses);
  assert.equal(card.due, patch.due);
  assert.equal(card.front, snap.front);
  assert.equal(card.id, 'g1');
  assert.deepEqual(ok.body.card.source, snap.source);
  assert.equal(bag.saves.length, 1);
  assert.equal(bag.pushes.length, 1);
  assert.equal(bag.events.length, 1);
  assert.deepEqual(bag.events[0], {
    type: 'srs_review', cardId: 'g1', grade: 2, itemId: 'item-1', interval: card.interval,
  });

  for (const g of [1, 3]) {
    const c = baseCard({ id: 'ok' + g });
    delete c.source;
    const b = makeDeps([c], { scheduleNow });
    const res = handleBridgeReview('/review/grade', 'POST', { cardId: c.id, grade: g }, b.d);
    assert.equal(res.status, 200);
    assert.equal(res.body.card.source, null);
    assert.equal(Object.prototype.hasOwnProperty.call(c, 'source'), false);
    assert.equal(b.scheduleArgs[0].grade, g);
    assert.equal(b.pushes.length, 1);
    assert.equal(b.events[0].type, 'srs_review');
    assert.equal(b.events[0].grade, g);
  }
});

check('成卡：source 白名单、去重更新、空正面与来源校验', () => {
  const items = {
    ok: { id: 'ok', title: '资料', trashed: false },
    gone: { id: 'gone', title: '已删', trashed: true },
  };
  const cards = [];
  const bag = makeDeps(cards, { getItem: (id) => items[id] || null });

  const empty = handleBridgeReview('/card', 'POST', { front: '   ', back: 'x' }, bag.d);
  assert.equal(empty.status, 400);
  assert.deepEqual(empty.body, { error: '卡面是空的' });
  assert.equal(cards.length, 0);
  assert.equal(bag.newCardSpecs.length, 0);
  assert.equal(bag.saves.length, 0);

  const missingSrc = handleBridgeReview('/card', 'POST', { front: '问', sourceItemId: 'missing' }, bag.d);
  assert.equal(missingSrc.status, 404);
  assert.deepEqual(missingSrc.body, { error: 'not found' });
  const trashedSrc = handleBridgeReview('/card', 'POST', { front: '问', sourceItemId: 'gone' }, bag.d);
  assert.equal(trashedSrc.status, 404);
  assert.equal(cards.length, 0);

  const dedupe = 'D'.repeat(200);
  const source = {
    app: 'A'.repeat(50),
    videoKey: 'V'.repeat(600),
    t: 12.5,
    mark: 'miss',
    noteName: 'N'.repeat(200),
    quote: 'Q'.repeat(400),
    dedupe,
    password: 'NO_LEAK_SRC',
    extra: 1,
  };
  const created = handleBridgeReview('/card', 'POST', {
    front: '  ' + 'F'.repeat(350) + '  ',
    back: '  ' + 'B'.repeat(900),
    sourceItemId: 'ok',
    source,
  }, bag.d);
  assert.equal(created.status, 200);
  assert.equal(created.body.ok, true);
  assert.equal(created.body.deduped, undefined);
  assert.equal(cards.length, 1);
  const card = cards[0];
  assert.equal(created.body.id, card.id);
  assert.equal(card.kind, 'manual');
  assert.equal(card.itemId, 'ok');
  assert.equal(card.front.length, 300);
  assert.equal(card.back.length, 800);
  assert.equal(card.front, 'F'.repeat(300));
  assert.equal(card.source.app.length, 40);
  assert.equal(card.source.videoKey.length, 500);
  assert.equal(card.source.noteName.length, 160);
  assert.equal(card.source.quote.length, 300);
  assert.equal(card.source.dedupe.length, 180);
  assert.equal(card.source.dedupe, dedupe.slice(0, 180));
  assert.equal(card.source.t, 12.5);
  assert.equal(card.source.mark, 'miss');
  assert.equal(card.source.password, undefined);
  assert.deepEqual(Object.keys(card.source).sort(), ['app', 'dedupe', 'mark', 'noteName', 'quote', 't', 'videoKey']);
  const reps = card.reps;
  const due = card.due;
  const id = card.id;

  const again = handleBridgeReview('/card', 'POST', {
    front: '更新后的问题',
    back: '更新后的答案',
    sourceItemId: 'ok',
    source: { dedupe, mark: 'key', app: 'desk' },
  }, bag.d);
  assert.equal(again.status, 200);
  assert.deepEqual(again.body, { ok: true, id, deduped: true });
  assert.equal(cards.length, 1);
  assert.equal(cards[0], card);
  assert.equal(card.id, id);
  assert.equal(card.front, '更新后的问题');
  assert.equal(card.back, '更新后的答案');
  assert.equal(card.reps, reps);
  assert.equal(card.due, due);
  assert.equal(card.itemId, 'ok');
  assert.deepEqual(card.source, { dedupe: dedupe.slice(0, 180), mark: 'key', app: 'desk' });
  assert.equal(bag.pushes.length, 0);

  const blocked = handleBridgeReview('/card', 'POST', { front: '', source: { dedupe }, sourceItemId: 'ok' }, bag.d);
  assert.equal(blocked.status, 400);
  assert.equal(card.front, '更新后的问题');

  cards.push({ id: 'dead', deleted: true, front: '旧', back: '旧', source: { dedupe: 'gone-key' }, trashed: false });
  cards.push({ id: 'trash', trashed: true, front: '旧', back: '旧', source: { dedupe: 'trash-key' } });
  const freshDead = handleBridgeReview('/card', 'POST', { front: '新卡', back: '背', source: { dedupe: 'gone-key', mark: 'reuse' } }, bag.d);
  assert.equal(freshDead.body.deduped, undefined);
  assert.notEqual(freshDead.body.id, 'dead');
  assert.equal(cards.filter(c => c.source && c.source.dedupe === 'gone-key').length, 2);
  const freshTrash = handleBridgeReview('/card', 'POST', { front: '另一张', back: '背', source: { dedupe: 'trash-key' } }, bag.d);
  assert.equal(freshTrash.body.deduped, undefined);
  assert.notEqual(freshTrash.body.id, 'trash');

  const plain = handleBridgeReview('/card', 'POST', { front: '无来源', back: '  背面  ' }, bag.d);
  const plainCard = cards.find(c => c.id === plain.body.id);
  assert.equal(plainCard.back, '背面');
  assert.equal(Object.prototype.hasOwnProperty.call(plainCard, 'source'), false);

  const badT = handleBridgeReview('/card', 'POST', {
    front: '时间字段',
    source: { app: 'x', t: -1, mark: 'nope', dedupe: '   ' },
  }, bag.d);
  const badCard = cards.find(c => c.id === badT.body.id);
  assert.deepEqual(badCard.source, { app: 'x' });
  const dupSpace = handleBridgeReview('/card', 'POST', {
    front: '时间字段二',
    source: { dedupe: '   ', app: 'y' },
  }, bag.d);
  assert.equal(dupSpace.body.deduped, undefined);
  assert.notEqual(dupSpace.body.id, badCard.id);

  const arrSrc = handleBridgeReview('/card', 'POST', { front: '数组来源', source: ['key'] }, bag.d);
  const arrCard = cards.find(c => c.id === arrSrc.body.id);
  assert.equal(Object.prototype.hasOwnProperty.call(arrCard, 'source'), false);

  assert.ok(bag.newCardSpecs.length >= 1);
  assert.equal(bag.newCardSpecs[0].kind, 'manual');
  assert.equal(bag.newCardSpecs[0].front.startsWith('F'), true);
});

check('非复习路径不接管；main 仍把调度交给 src/srs.js', () => {
  const bag = makeDeps([], {});
  assert.equal(handleBridgeReview('/ping', 'GET', null, bag.d), null);
  assert.equal(handleBridgeReview('/review/due', 'POST', {}, bag.d), null);
  assert.equal(handleBridgeReview('/review/grade', 'GET', {}, bag.d), null);
  assert.equal(handleBridgeReview('/card', 'GET', {}, bag.d), null);
  const mainSrc = fs.readFileSync(path.join(ROOT, 'main.js'), 'utf8');
  assert.ok(mainSrc.includes("const { handleBridgeReview } = require('./src/bridge-review');"));
  assert.ok(mainSrc.includes('schedule: srs.schedule'));
  assert.ok(mainSrc.includes('dueCards: srs.dueCards'));
  assert.ok(mainSrc.includes('newCard: srs.newCard'));
  assert.ok(mainSrc.includes("handleBridgeReview(p, req.method"));
  assert.ok(mainSrc.includes("'/review/due'"));
  assert.ok(mainSrc.includes("'/review/grade'"));
  assert.ok(mainSrc.includes('/^127\\.0\\.0\\.1(:\\d+)?$/'));
  assert.ok(mainSrc.includes('[1, 2, 3].includes(grade) ? grade : 3'));
  assert.ok(mainSrc.includes("type: 'srs_review'"));
  assert.equal(fs.readFileSync(path.join(ROOT, 'src', 'srs.js'), 'utf8').includes('function newCard({ itemId, kind, front, back })'), true);
});

console.log('\nBRIDGE_REVIEW_OK（' + passed + ' 组通过）');
