import { test } from 'node:test';
import assert from 'node:assert/strict';
import { emptyDoc, setKey, deleteKey, entryWins, merge, validDoc, valueOf, MAX_KEY } from './crdt.mjs';

const D = () => emptyDoc('mesh');
const put = (doc, node, k, v) => setKey(doc, node, k, v).doc;

test('emptyDoc and validDoc', () => {
  assert.deepEqual(D(), { docId: 'mesh', lamport: 0, entries: {} });
  for (const bad of ['', 5, null, undefined]) assert.equal(emptyDoc(bad), null);
  assert.equal(validDoc(D()), true);
  const good = put(D(), 'a', 'k', 1);
  assert.equal(validDoc(good), true);
  const e = good.entries.k;
  const with_ = (over) => ({ ...good, entries: { k: { ...e, ...over } } });
  for (const [over, why] of [[{ ts: 0 }, 'ts from 1'], [{ ts: 1.5 }, 'whole ts'], [{ ts: 2 }, 'a ts past the clock'], [{ nodeId: '' }, 'a node'], [{ nodeId: 5 }, 'a node'], [{ deleted: 'no' }, 'deleted is true or false'], [{ value: undefined }, 'a value'], [{ value: () => 1 }, 'plain JSON'], [{ deleted: true, value: 1 }, 'a tombstone holds null']]) assert.equal(validDoc(with_(over)), false, why);
  const noValue = { ...good, entries: { k: { ts: 1, nodeId: 'a', deleted: false } } };
  assert.equal(validDoc(noValue), false, 'an entry must carry its value');
  assert.equal(validDoc(with_({ deleted: true, value: null })), true);
  assert.equal(validDoc({ ...good, entries: { ['x'.repeat(MAX_KEY + 1)]: e } }), false, 'a key past the limit');
  assert.equal(validDoc({ ...good, entries: { ['x'.repeat(MAX_KEY)]: e } }), true);
  assert.equal(validDoc({ ...good, entries: { '': e } }), false);
  for (const bad of [null, [], 'x', { docId: '', lamport: 0, entries: {} }, { docId: 'm', lamport: -1, entries: {} }, { docId: 'm', lamport: 1.5, entries: {} }, { docId: 'm', lamport: 0, entries: [] }, { docId: 5, lamport: 0, entries: {} }, { docId: 'm', lamport: 0, entries: { k: null } }]) assert.equal(validDoc(bad), false, JSON.stringify(bad));
  assert.equal(MAX_KEY, 256);
});

test('setKey and deleteKey: the clock ticks, the write is stamped, the document given is not changed', () => {
  const d0 = D();
  const r = setKey(d0, 'a', 'k', { n: [1, 'x', null, true] });
  assert.deepEqual(r, { ok: true, doc: { docId: 'mesh', lamport: 1, entries: { k: { value: { n: [1, 'x', null, true] }, ts: 1, nodeId: 'a', deleted: false } } }, entry: { value: { n: [1, 'x', null, true] }, ts: 1, nodeId: 'a', deleted: false } });
  assert.deepEqual(d0, D(), 'the old document is untouched');
  const r2 = deleteKey(r.doc, 'b', 'k');
  assert.deepEqual(r2.entry, { value: null, ts: 2, nodeId: 'b', deleted: true });
  assert.deepEqual(valueOf(r2.doc), {});
  assert.deepEqual(r.doc.entries.k.deleted, false);
  assert.deepEqual(setKey(null, 'a', 'k', 1), { ok: false, why: 'not a document' });
  assert.deepEqual(setKey(D(), '', 'k', 1), { ok: false, why: 'a write names its node' });
  assert.deepEqual(setKey(D(), 5, 'k', 1), { ok: false, why: 'a write names its node' });
  for (const k of ['', 5, 'x'.repeat(MAX_KEY + 1)]) assert.deepEqual(setKey(D(), 'a', k, 1), { ok: false, why: 'a key is 1–256 characters' });
  for (const v of [undefined, NaN, Infinity, () => 1, new Date(0), Object.create(null)]) assert.deepEqual(setKey(D(), 'a', 'k', v), { ok: false, why: 'the value is not plain JSON' });
  let deep = 1; for (let i = 0; i < 33; i++) deep = [deep];
  assert.equal(setKey(D(), 'a', 'k', deep).ok, false, 'nested past 32');
  let deepObj = 1; for (let i = 0; i < 33; i++) deepObj = { a: deepObj };
  assert.equal(setKey(D(), 'a', 'k', deepObj).ok, false, 'records nested past 32');
  let okObj = 1; for (let i = 0; i < 32; i++) okObj = { a: okObj };
  assert.equal(setKey(D(), 'a', 'k', okObj).ok, true, 'records nested 32 deep');
  assert.deepEqual(emptyDoc('x'), { docId: 'x', lamport: 0, entries: {} }, 'a one-letter document');
  assert.equal(validDoc(emptyDoc('x')), true);
  let ok = 1; for (let i = 0; i < 32; i++) ok = [ok];
  assert.equal(setKey(D(), 'a', 'k', ok).ok, true);
  assert.equal(deleteKey(D(), 'a', 'k').ok, true, 'deleting what was never set still converges');
  assert.deepEqual(deleteKey(D(), 'a', '').why, 'a key is 1–256 characters');
});

test('entryWins: the later time, then the larger node id', () => {
  const e = (ts, nodeId) => ({ ts, nodeId });
  assert.equal(entryWins(e(2, 'a'), e(1, 'z')), true);
  assert.equal(entryWins(e(1, 'z'), e(2, 'a')), false);
  assert.equal(entryWins(e(1, 'b'), e(1, 'a')), true);
  assert.equal(entryWins(e(1, 'a'), e(1, 'b')), false);
  assert.equal(entryWins(e(1, 'a'), e(1, 'a')), false, 'the same write does not replace itself');
  assert.equal(entryWins(e(1, 'a'), undefined), true);
  assert.equal(entryWins(undefined, e(1, 'a')), false);
});

test('merge: the winning entry stays; commutative, associative, idempotent, whatever order', () => {
  const a = put(put(D(), 'a', 'x', 1), 'a', 'y', 2);       // lamport 2
  const b = put(D(), 'b', 'x', 9);                          // lamport 1
  const m = merge(a, b);
  assert.deepEqual([m.ok, m.changed, valueOf(m.doc), m.doc.lamport], [true, ['x'], { x: 9, y: 2 }, 2], 'both wrote x at time 1: the larger node id');
  const m2 = merge(b, a);
  assert.deepEqual([m2.changed, valueOf(m2.doc), m2.doc.lamport], [['y'], { x: 9, y: 2 }, 2]);
  const later = put(put(D(), 'a', 'z', 0), 'a', 'x', 1);    // x at time 2
  assert.deepEqual(valueOf(merge(later, b).doc), { x: 1, z: 0 }, 'a later write keeps its key');
  assert.deepEqual(merge(a, a).changed, [], 'idempotent');
  assert.deepEqual(valueOf(merge(merge(a, b).doc, b).doc), valueOf(merge(a, b).doc));
  const tie1 = put(D(), 'a', 'k', 'from a'), tie2 = put(D(), 'b', 'k', 'from b');
  assert.deepEqual(valueOf(merge(tie1, tie2).doc), { k: 'from b' }, 'a tie: the larger node id');
  assert.deepEqual(valueOf(merge(tie2, tie1).doc), { k: 'from b' });
  assert.deepEqual(merge(a, { ...b, docId: 'other' }), { ok: false, why: 'another document' });
  assert.deepEqual(merge(null, a), { ok: false, why: 'not a document' });
  assert.deepEqual(merge(a, 'x'), { ok: false, why: 'not a document' });
  const before = JSON.stringify(a);
  merge(a, b);
  assert.equal(JSON.stringify(a), before, 'merge changes neither document');
  // the laws, on random documents from three nodes
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
  for (let round = 0; round < 200; round++) {
    const docs = ['a', 'b', 'c'].map((node) => { let d = D(); for (let i = rnd(6); i > 0; i--) d = rnd(4) === 0 ? deleteKey(d, node, 'k' + rnd(4)).doc : put(d, node, 'k' + rnd(4), rnd(100)); return d; });
    const [x, y, z] = docs;
    const v = (d) => JSON.stringify(valueOf(d)) + '|' + JSON.stringify(Object.keys(d.entries).sort().map((k) => [k, d.entries[k]]));
    assert.equal(v(merge(x, y).doc), v(merge(y, x).doc), 'commutative');
    assert.equal(v(merge(merge(x, y).doc, z).doc), v(merge(x, merge(y, z).doc).doc), 'associative');
    assert.equal(v(merge(merge(x, y).doc, y).doc), v(merge(x, y).doc), 'idempotent');
  }
});

test('valueOf: live keys only, in order; not a document is nothing', () => {
  let d = put(put(put(D(), 'a', 'b', 2), 'a', 'a', 1), 'a', 'c', 3);
  d = deleteKey(d, 'a', 'c').doc;
  assert.deepEqual(Object.keys(valueOf(d)), ['a', 'b']);
  assert.deepEqual(valueOf(d), { a: 1, b: 2 });
  assert.equal(valueOf('x'), null);
});
