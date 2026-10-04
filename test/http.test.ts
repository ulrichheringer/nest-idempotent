import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MemoryStore, type IdempotencyStore } from '../src';
import { appFor } from './http-fixture';
test('HTTP replay status/body/safe headers; missing key/scope; plain bypass', async () => {
  const { app, send, controller } = await appFor();
  try {
    assert.equal((await send(undefined)).status, 400);
    assert.equal((await send('key', {}, '/orders', '')).status, 400);
    assert.equal((await send(undefined, {}, '/plain')).status, 201);
    const original = await send('replay');
    const body = await original.json();
    assert.equal(original.status, 201);
    assert.ok(original.headers.get('set-cookie'));
    const replay = await send('replay');
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(replay.headers.get('location'), '/orders/42');
    assert.equal(replay.headers.get('set-cookie'), null);
    assert.deepEqual(await replay.json(), body);
    assert.equal(controller.calls, 1);
  } finally {
    await app.close();
  }
});
test('HTTP concurrency rejects pending duplicates; fingerprint, query, path and tenant isolation', async () => {
  const { app, send, controller } = await appFor();
  try {
    const pending = send('concurrent', { delay: 50 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await send('concurrent', { delay: 50 })).status, 409);
    assert.equal((await pending).status, 201);
    assert.equal(controller.calls, 1);
    assert.equal((await send('concurrent', { different: true })).status, 409);
    assert.equal(
      (await send('concurrent', { delay: 50 }, '/orders?x=1')).status,
      409,
    );
    assert.equal((await send('concurrent', {}, '/timeout')).status, 409);
    assert.equal((await send('concurrent', {}, '/orders', 'b')).status, 201);
    assert.equal(controller.calls, 2);
  } finally {
    await app.close();
  }
});
test('HTTP completed TTL permits fresh execution; handler failures release own reservation', async () => {
  const { app, send, controller } = await appFor();
  try {
    assert.equal((await send('ttl')).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await send('ttl')).status, 201);
    assert.equal(controller.calls, 2);
    assert.equal((await send('fail', { fail: true })).status, 422);
    assert.equal((await send('fail', { fail: false })).status, 201);
  } finally {
    await app.close();
  }
});
test('HTTP timeout aborts cooperative handler and retains reservation until lease expires', async () => {
  const { app, send, controller } = await appFor();
  try {
    assert.equal((await send('timeout', {}, '/timeout')).status, 504);
    assert.equal((await send('timeout', {}, '/timeout')).status, 409);
    assert.equal(controller.calls, 1);
  } finally {
    await app.close();
  }
});
test('HTTP storage errors fail closed before handler execution', async () => {
  const store: IdempotencyStore = {
    acquire: async () => {
      throw new Error('offline');
    },
    complete: async () => false,
    release: async () => {},
  };
  const { app, send, controller } = await appFor(store);
  try {
    assert.equal((await send('offline')).status, 503);
    assert.equal(controller.calls, 0);
  } finally {
    await app.close();
  }
});
test('HTTP failure persisting an executed result retains reservation', async () => {
  const memory = new MemoryStore();
  const store: IdempotencyStore = {
    acquire: memory.acquire.bind(memory),
    complete: async () => {
      throw new Error('offline');
    },
    release: memory.release.bind(memory),
  };
  const { app, send, controller } = await appFor(store);
  try {
    assert.equal((await send('offline')).status, 503);
    assert.equal((await send('offline')).status, 409);
    assert.equal(controller.calls, 1);
  } finally {
    await app.close();
  }
});
