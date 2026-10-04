# nest-idempotent

Declarative idempotency for NestJS 11 HTTP JSON endpoints, with atomic Redis/Valkey and PostgreSQL stores. Requires Node.js 24 or newer and the Express HTTP adapter.

A successful request persists its status, JSON body and selected headers before returning. An identical retry replays that response. Concurrent requests receive `409` while a reservation is active; reusing a key for another request also returns `409`.

## Install

```sh
npm install nest-idempotent @nestjs/common @nestjs/core reflect-metadata rxjs
# Install only the driver you use:
npm install redis
# or: npm install pg
```

This repository provides a library; it does not deploy an application or provision infrastructure. The package is prepared for npm publication; install from a local `npm pack` tarball until a registry release is available.

## Quick start

```ts
import { Controller, Module, Post, Body } from '@nestjs/common';
import { createClient } from 'redis';
import {
  IdempotencyModule,
  Idempotent,
  RedisStore,
  type IdempotencyRequest,
} from 'nest-idempotent';

interface AuthenticatedRequest extends IdempotencyRequest {
  user?: { tenantId: string; id: string };
}

// Connect during bootstrap; the application owns this client's lifecycle.
const redis = createClient({ url: process.env.REDIS_URL });
await redis.connect();

@Controller('orders')
class OrdersController {
  @Post()
  @Idempotent({ ttlMs: 86_400_000 })
  create(@Body() body: { sku: string }) {
    return { id: 'order-42', sku: body.sku };
  }
}

@Module({
  imports: [
    IdempotencyModule.forRoot({
      store: new RedisStore(redis, 'orders:idempotency:'),
      namespace: 'orders-api',
      scope: (request) => {
        const user = (request as AuthenticatedRequest).user;
        return user ? JSON.stringify([user.tenantId, user.id]) : '';
      },
    }),
  ],
  controllers: [OrdersController],
})
export class AppModule {}
```

Use your authentication guard to populate `request.user`. Guards run on original requests and replays, so authorization is checked each time. Never use a client-provided tenant header as trusted scope. Missing/empty scope or an absent/invalid `Idempotency-Key` returns `400`. Decorated controllers protect all their handlers; method options override controller options. Undecorated handlers run normally.

```sh
curl -X POST http://localhost:3000/orders \
  -H 'Authorization: Bearer YOUR_TOKEN' \
  -H 'Idempotency-Key: order-request-42' \
  -H 'Content-Type: application/json' \
  -d '{"sku":"book"}'
```

The key must be 1–200 printable ASCII characters without spaces. Send the same key and payload again to get `Idempotency-Replayed: true`; the initial result has `false`. See [examples/orders.ts](examples/orders.ts) for a typed bootstrap and cooperative cancellation example.

## Configuration

| Option             | Default                      | Meaning                                                           |
| ------------------ | ---------------------------- | ----------------------------------------------------------------- |
| `store`            | required                     | An `IdempotencyStore` implementation.                             |
| `scope`            | required                     | Sync/async resolver returning a nonempty server-trusted identity. |
| `namespace`        | `default`                    | Server-owned application identity.                                |
| `ttlMs`            | `86400000`                   | Replay lifetime, beginning when completion is persisted.          |
| `leaseMs`          | `60000`                      | Lifetime of a pending reservation; no automatic renewal.          |
| `timeoutMs`        | `30000`                      | Maximum handler wait; must be less than `leaseMs`.                |
| `maxResponseBytes` | `1048576`                    | Maximum UTF-8 JSON body size.                                     |
| `varyHeaders`      | `['content-type', 'accept']` | Request headers included in the fingerprint.                      |

`@Idempotent()` can override `ttlMs`, `leaseMs`, and `timeoutMs`. Durations and size limits must be positive safe integers. Register `forRoot` once in the root application module; it installs an `APP_INTERCEPTOR` that acts only on decorated endpoints.

The storage key hashes **namespace + trusted scope + client key**. The client key is unique across routes within that scope: using the same key on a different path yields a conflict. The fingerprint covers method, path, parsed query, parsed body, and configured varying headers. Object keys use stable code-unit ordering across replicas; array order and value types remain significant. Query parameter ordering is normalized by parsing, while repeated parameter array ordering remains significant. Header values are compared literally. Include every header that can change endpoint semantics in `varyHeaders`, or incorporate verified identity into scope. Keep configuration consistent across replicas.

## Storage adapters

### Redis and Valkey

```ts
const client = createClient({ url: process.env.REDIS_URL });
await client.connect();
const store = new RedisStore(client, 'my-api:idempotency:');
// On application shutdown:
await client.quit();
```

The adapter accepts the structural node-redis v5 `eval` interface; it loads no driver. Each claim, completion and release is a single-key Lua operation, compatible with Redis Cluster. Keys expire using Redis TTL. Response JSON remains an opaque string inside the Lua envelope to preserve arrays and JavaScript number precision. Use a distinct nonempty prefix per application. Redis eviction, failover data loss and persistence settings determine retention guarantees; use appropriate persistence and avoid evicting idempotency keys.

### PostgreSQL

```ts
import { Pool } from 'pg';
import { PostgresStore } from 'nest-idempotent';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PostgresStore(pool, 'orders_idempotency');
await store.migrate(); // deployment migration, before serving traffic
// Pass store to IdempotencyModule.forRoot(...).
await store.prune(); // periodic maintenance; expiry is checked without pruning
await pool.end(); // application shutdown
```

The adapter supports `pg` Pool/Client through a structural query interface. The table name must match `[a-z_][a-z0-9_]*`. `migrate()` creates the table and expiry index and is safe to repeat; production teams may manage the equivalent schema themselves. Atomic `INSERT ... ON CONFLICT` claims and conditional updates use database time, owner tokens and expiry checks. No process-local locks or long-lived transaction is held while a handler runs. Grant schema permissions to deployment tooling and appropriate DML permissions to the runtime.

### Development

`new MemoryStore()` implements the same contract for tests or single-process development. It is unsuitable for multiple replicas or persistence, and expired keys are only reclaimed when accessed. Production services should use Redis or PostgreSQL.

## Outcomes and failure behavior

| Outcome                                            | HTTP behavior                                                   |
| -------------------------------------------------- | --------------------------------------------------------------- |
| Missing/invalid key, scope or JSON input           | `400`, handler is not called.                                   |
| Active duplicate or mismatched fingerprint         | `409`, handler is not called.                                   |
| Successful persisted response                      | Original status/body, then replay while TTL lasts.              |
| Handler throws                                     | Original exception; owner-checked release allows a retry.       |
| Handler wait times out                             | `504`; signal aborted; reservation retained until lease expiry. |
| Storage unavailable or ownership lost              | `503`; fails closed.                                            |
| Result too large, invalid or already sent manually | Cannot persist; reservation retained until lease expiry.        |

Only `content-type`, `content-language`, `location`, `etag` and `cache-control` are replayed. Cookies, authorization headers, request-specific IDs and hop-by-hop headers are excluded. Persisted envelopes are validated before replay. Status codes `200–499` returned normally can be stored; exceptions are not stored. `5xx` results are not replayed.

The adapter uses a random owner token and compare-and-set completion/release. A stale execution cannot finalize or delete a successor's reservation. If completion storage fails after a handler succeeds, the uncertain reservation is retained instead of allowing an immediate retry. Cancellation is cooperative: `request.idempotencySignal` is aborted on timeout/error; pass it to cancellable I/O and check it before performing effects.

## Guarantees and boundaries

This library deduplicates HTTP execution during a lease and replays persisted responses during TTL. It does **not** guarantee exactly-once external effects. A process may crash after an effect but before storing the response. A handler that ignores cancellation may continue past lease expiry while a retry starts. Bound execution time below the lease, allow a margin for storage/network latency, and enforce transactional uniqueness or downstream idempotency for irreversible operations. Failed handlers may also have committed partial effects before throwing.

Use ordinary Nest-managed JSON returns. Streaming, SSE, multipart uploads, binary responses, manually sent `@Res()` responses, GraphQL and Fastify are outside this version's scope. Passthrough `@Res({ passthrough: true })` may set status/headers while Nest sends the body. The interceptor stores the JSON result it receives: place serialization/transformation interceptors inside it, and test application-level filters/interceptors that mutate responses afterward. Storage operations rely on driver connection/query timeouts; configure those in your client. Scope resolver errors propagate and never bypass idempotency.

Treat persisted payloads as application data: apply authentication, retention, storage security and key limits appropriate to your service. Once TTL expires, the same key may execute again.

## Development and verification

```sh
npm ci
npm run format:check
npm run lint
npm run typecheck
npm test
npm run test:integration
npm run build
npm pack
```

Integration tests use **real infrastructure**, and fail if it is absent; they are not silently skipped. Defaults are Redis at `redis://localhost:6393` and PostgreSQL at `postgres://postgres:txrelay@localhost:15432/txrelay`. Override `REDIS_URL` and `DATABASE_URL` for your environment. Tests create unique Redis prefixes and PostgreSQL tables; they never flush the shared Redis database or drop existing application tables. Docker is needed only if you choose to run infrastructure containers, not to build or test this library.

The GitHub Actions workflow runs native Node.js with Redis/PostgreSQL service containers, lint, formatting, type checking, unit/HTTP tests, real adapter/HTTP integration tests, build and package validation. Test coverage includes owner fencing, concurrent claims, response fidelity (`[]`, `{}`, large integers and floats), corrupt records, TTL, trusted scopes, fingerprints, safe headers, failure cleanup, timeout cancellation and fail-closed storage errors.

## Design references

- [NestJS interceptors](https://docs.nestjs.com/interceptors)
- [Redis EVAL](https://redis.io/docs/latest/commands/eval/)
- [PostgreSQL INSERT and ON CONFLICT](https://www.postgresql.org/docs/current/sql-insert.html)

## License

[MIT](LICENSE).
