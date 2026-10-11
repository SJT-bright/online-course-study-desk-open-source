// Small local review scheduler. No external Learning Vault installation is required.
const { randomUUID } = require('node:crypto');
const DAY = 86400000;
function anchor4am(now = Date.now()) {
  const date = new Date(now); if (date.getHours() < 4) date.setDate(date.getDate() - 1); date.setHours(4,0,0,0); return date.getTime();
}
function newCard({ itemId = null, kind = 'manual', front, back = '' }, now = Date.now()) {
  return { id: randomUUID(), itemId, kind, front, back, due: anchor4am(now) + DAY, interval: 0, reps: 0, lapses: 0, ease: 2.5, suspended: false };
}
function schedule(card, grade, now = Date.now()) {
  if (![1,2,3].includes(grade)) throw new Error('Invalid review grade');
  const previous = Math.max(0, Number(card.interval) || 0);
  let reps = Math.max(0, Number(card.reps) || 0), lapses = Math.max(0, Number(card.lapses) || 0);
  let ease = Math.max(1.3, Number(card.ease) || 2.5), interval;
  if (grade === 1) { reps = 0; lapses++; ease = Math.max(1.3,ease-0.2); interval = 1; }
  else { interval = reps === 0 ? 1 : reps === 1 ? 6 : Math.max(1,Math.round(previous * ease * (grade === 3 ? 1.3 : 1))); reps++; if (grade === 3) ease += 0.1; }
  // Calendar days retain 04:00 across daylight saving time changes.
  const due = new Date(anchor4am(now)); due.setDate(due.getDate() + interval);
  return { ...card, reps, lapses, ease, interval, due: due.getTime(), lastReview: now };
}
function dueCards(cards, now = Date.now(), limit = 20) {
  return cards.filter(c => c && !c.suspended && !c.deleted && Number(c.due) <= now).sort((a,b) => a.due-b.due).slice(0,limit);
}
module.exports = { anchor4am, newCard, schedule, dueCards };
