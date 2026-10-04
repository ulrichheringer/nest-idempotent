import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { Pool } from 'pg';
import { createClient } from 'redis';
import { PostgresStore, RedisStore } from '../src';
import { storeSuite } from './store-fixture';
test('real Redis Lua store', async () => {
  const client = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6393',
  });
  await client.connect();
  const prefix = `nest-idempotent:test:${randomUUID()}:`;
  try {
    await storeSuite(new RedisStore(client, prefix), 'suite');
    await client.set(
      prefix + 'corrupt',
      '{"owner":"x","fingerprint":"fp","response":"garbage"}',
    );
    await assert.rejects(
      new RedisStore(client, prefix).acquire('corrupt', 'fp', 'owner', 100),
    );
    await client.del(prefix + 'corrupt');
  } finally {
    await client.quit();
  }
});
test('real PostgreSQL store', async () => {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://postgres:txrelay@localhost:15432/txrelay',
  });
  const table = `nest_idempotent_test_${randomUUID().replaceAll('-', '')}`;
  const store = new PostgresStore(pool, table);
  try {
    await store.migrate();
    await storeSuite(store, 'suite');
    await pool.query(
      `INSERT INTO "${table}" (key,fingerprint,owner,response,expires_at) VALUES ('bad','fp','x','{}',clock_timestamp()+interval '1 minute')`,
    );
    await assert.rejects(store.acquire('bad', 'fp', 'owner', 100));
    await pool.query(`DELETE FROM "${table}" WHERE key = 'bad'`);
    await store.acquire('expired', 'fp', 'x', 1);
    await new Promise((resolve) => setTimeout(resolve, 10));
    assert.equal(await store.prune(), 1);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
  }
});
import { appFor } from './http-fixture';
import type { IdempotencyStore } from '../src';
async function httpSuite(store: IdempotencyStore): Promise<void> {
  const { app, send, controller } = await appFor(store);
  try {
    const initial = await send('http', { delay: 10 }, '/orders?a=1&b=2');
    const expected = await initial.json();
    assert.equal(initial.status, 201);
    const replay = await send('http', { delay: 10 }, '/orders?b=2&a=1');
    assert.deepEqual(await replay.json(), expected);
    assert.equal(replay.status, 201);
    assert.equal(replay.headers.get('set-cookie'), null);
    assert.equal(replay.headers.get('idempotency-replayed'), 'true');
    assert.equal(controller.calls, 1);
    assert.equal((await send('http', { changed: true })).status, 409);
    assert.equal(
      (await send('http', {}, '/orders', 'second-tenant')).status,
      201,
    );
    const pending = send('race', { delay: 40 });
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal((await send('race', { delay: 40 })).status, 409);
    assert.equal((await pending).status, 201);
    await new Promise((resolve) => setTimeout(resolve, 120));
    assert.equal((await send('http', {})).status, 201);
    assert.equal((await send('failure', { fail: true })).status, 422);
    assert.equal((await send('failure', {})).status, 201);
  } finally {
    await app.close();
  }
}
test('Nest HTTP end-to-end with real Redis', async () => {
  const client = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6393',
  });
  await client.connect();
  const prefix = `nest-idempotent:http:${randomUUID()}:`;
  try {
    await httpSuite(new RedisStore(client, prefix));
  } finally {
    // Delete only this run's records; never FLUSHDB on a shared Redis instance.
    for await (const keys of client.scanIterator({
      MATCH: prefix + '*',
      COUNT: 100,
    }))
      if (keys.length) await client.del(keys);
    await client.quit();
  }
});
test('Nest HTTP end-to-end with real PostgreSQL', async () => {
  const pool = new Pool({
    connectionString:
      process.env.DATABASE_URL ??
      'postgres://postgres:txrelay@localhost:15432/txrelay',
  });
  const table = `nest_idempotent_http_${randomUUID().replaceAll('-', '')}`;
  const store = new PostgresStore(pool, table);
  try {
    await store.migrate();
    await httpSuite(store);
  } finally {
    await pool.query(`DROP TABLE IF EXISTS "${table}"`);
    await pool.end();
  }
});
