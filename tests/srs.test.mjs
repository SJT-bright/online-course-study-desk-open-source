import test from 'node:test';
import assert from 'node:assert/strict';
import srs from '../lib/srs.cjs';
test('local review works without a vault and handles recall, forgetting and suspended cards',()=>{
  const now = new Date(2026,9,12,12).getTime();
  const card = srs.newCard({front:'Question',back:'Answer'},now);
  assert.equal(srs.dueCards([card],now).length,0);
  const first=srs.schedule(card,2,now); assert.equal(first.interval,1); assert.equal(first.reps,1);
  const second=srs.schedule(first,2,now); assert.equal(second.interval,6); assert.equal(second.reps,2);
  const forgotten=srs.schedule(second,1,now); assert.equal(forgotten.interval,1); assert.equal(forgotten.lapses,1);
  assert.equal(new Date(forgotten.due).getHours(),4);
  assert.deepEqual(srs.dueCards([{...forgotten,suspended:true}],forgotten.due),[]);
  assert.throws(()=>srs.schedule(card,4,now),/Invalid/);
});
