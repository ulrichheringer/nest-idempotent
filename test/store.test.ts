import { canonicalJson } from '../src/nest';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  IdempotencyModule,
  MemoryStore,
  PostgresStore,
  RedisStore,
} from '../src';
import { storeSuite } from './store-fixture';
test('memory store atomic ownership, replay, TTL, stale owner fencing', async () =>
  storeSuite(new MemoryStore(), 'unit'));
test('fingerprint sorts objects but preserves arrays and value types', () => {
  assert.equal(
    canonicalJson({ b: [1, 2], a: {} }),
    canonicalJson({ a: {}, b: [1, 2] }),
  );
  assert.equal(canonicalJson({ '�': 1, z: 2, A: 3 }), '{"A":3,"z":2,"�":1}');
  assert.notEqual(canonicalJson([1, 2]), canonicalJson([2, 1]));
  assert.throws(() => canonicalJson({ n: NaN }));
});
test('configuration validation', () => {
  assert.throws(
    () =>
      new PostgresStore(
        { query: async () => ({ rows: [], rowCount: 0 }) },
        'bad;sql',
      ),
  );
  assert.throws(() => new RedisStore({ eval: async () => '' }, ''));
  assert.throws(() =>
    IdempotencyModule.forRoot({
      store: new MemoryStore(),
      scope: () => 'tenant',
      leaseMs: 10,
      timeoutMs: 10,
    }),
  );
  assert.throws(() =>
    IdempotencyModule.forRoot({
      store: new MemoryStore(),
      scope: () => 'tenant',
      ttlMs: -1,
    }),
  );
});
