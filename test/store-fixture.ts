import assert from 'node:assert/strict';
import type { IdempotencyStore, StoredResponse } from '../src';
export const sample: StoredResponse = {
  status: 201,
  headers: { location: '/orders/1' },
  body: {
    arrays: [[], {}],
    integer: Number.MAX_SAFE_INTEGER,
    float: 1.2345678901234567,
  },
};
export async function storeSuite(
  store: IdempotencyStore,
  key: string,
): Promise<void> {
  const claims = await Promise.all(
    Array.from({ length: 12 }, (_, i) =>
      store.acquire(key, 'fp', `owner-${i}`, 1000),
    ),
  );
  assert.equal(claims.filter((c) => c.kind === 'acquired').length, 1);
  assert.equal(claims.filter((c) => c.kind === 'busy').length, 11);
  const owner = `owner-${claims.findIndex((c) => c.kind === 'acquired')}`;
  assert.deepEqual(await store.acquire(key, 'changed', 'other', 1000), {
    kind: 'conflict',
  });
  assert.equal(await store.complete(key, 'wrong', sample, 1000), false);
  await store.release(key, 'wrong');
  assert.deepEqual(await store.acquire(key, 'fp', 'new', 1000), {
    kind: 'busy',
  });
  assert.equal(await store.complete(key, owner, sample, 90), true);
  await store.release(key, owner);
  const replay = await store.acquire(key, 'fp', 'new', 1000);
  assert.deepEqual(replay, { kind: 'replay', response: sample });
  if (replay.kind === 'replay') replay.response.status = 404;
  assert.deepEqual(await store.acquire(key, 'fp', 'new', 1000), {
    kind: 'replay',
    response: sample,
  });
  await new Promise((resolve) => setTimeout(resolve, 110));
  assert.deepEqual(await store.acquire(key, 'new-fp', 'next', 30), {
    kind: 'acquired',
  });
  await new Promise((resolve) => setTimeout(resolve, 45));
  assert.equal(await store.complete(key, 'next', sample, 1000), false);
  assert.deepEqual(await store.acquire(key, 'new-fp', 'replacement', 1000), {
    kind: 'acquired',
  });
  await store.release(key, 'next');
  assert.deepEqual(await store.acquire(key, 'new-fp', 'next', 1000), {
    kind: 'busy',
  });
  await store.release(key, 'replacement');
  assert.deepEqual(await store.acquire(key, 'fresh', 'released', 1000), {
    kind: 'acquired',
  });
  await store.release(key, 'released');
}
