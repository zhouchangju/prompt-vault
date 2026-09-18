import test from 'node:test';
import assert from 'node:assert/strict';
import { sortFolders, createPanelOrder } from '../core/order.js';
const ids = rows => rows.map(row => row.id);

test('folders use persisted ranks and deterministic name/id fallback without mutating input', () => {
  const rows = [{ id: 'b', name: 'A', sortOrder: 2 }, { id: 'z', name: 'Z', sortOrder: 0 },
    { id: 'a', name: 'A', sortOrder: 2 }];
  assert.deepEqual(ids(sortFolders(rows)), ['z', 'a', 'b']);
  assert.deepEqual(ids(rows), ['b', 'z', 'a']);
});

test('panel favorites always precede nonfavorites; frozen use counts survive usage and focus reloads', () => {
  const rows = [{ id: 'a', useCount: 3, favorite: true }, { id: 'b', useCount: 9, favorite: true },
    { id: 'c', useCount: 99 }, { id: 'd', useCount: 5 }];
  const order = createPanelOrder(rows);
  assert.deepEqual(ids(order.sort(rows)), ['b', 'a', 'c', 'd']);
  const updated = rows.map(row => ({ ...row, useCount: row.id === 'd' ? 1000 : 0, lastUsedAt: 200 }));
  assert.deepEqual(ids(order.sort(updated)), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids(order.sort([...updated].reverse())), ['b', 'a', 'c', 'd']);
  assert.deepEqual(ids(createPanelOrder(updated).sort(updated)), ['a', 'b', 'd', 'c']);
});

test('favorite toggles intentionally regroup using the frozen score', () => {
  const rows = [{ id: 'a', useCount: 3, favorite: true }, { id: 'b', useCount: 9 }];
  const order = createPanelOrder(rows);
  assert.deepEqual(ids(order.sort(rows)), ['a', 'b']);
  assert.deepEqual(ids(order.sort(rows.map(row => ({ ...row, favorite: true })))), ['b', 'a']);
  assert.deepEqual(ids(order.sort(rows.map(row => ({ ...row, favorite: false })))), ['b', 'a']);
});

test('new records insert deterministically; all tie fields and input objects remain independent', () => {
  const a = { id: 'a', useCount: 2, sortOrder: 2, createdAt: 20 };
  const b = { id: 'b', useCount: 2, sortOrder: 1, createdAt: 10 };
  const order = createPanelOrder([a, b]);
  a.sortOrder = 0; a.createdAt = 0; a.useCount = 500;
  const c = { id: 'c', useCount: 2, sortOrder: 1, createdAt: 10 };
  assert.deepEqual(ids(order.sort([a, c, b])), ['b', 'c', 'a']);
  assert.deepEqual(ids(order.sort([a, { ...c, useCount: 999 }, b])), ['b', 'c', 'a']);
});
