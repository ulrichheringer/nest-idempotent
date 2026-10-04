import 'reflect-metadata';
import { Body, Controller, Module, Post, Req } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { createClient } from 'redis';
import { Pool } from 'pg';
import {
  IdempotencyModule,
  Idempotent,
  RedisStore,
  PostgresStore,
  type IdempotencyRequest,
} from '../src';
interface AuthenticatedRequest extends IdempotencyRequest {
  user?: { tenantId: string; id: string };
}
@Controller('orders')
class OrdersController {
  @Post()
  @Idempotent({ ttlMs: 24 * 60 * 60 * 1000 })
  async create(
    @Body() body: { sku: string },
    @Req() request: AuthenticatedRequest,
  ) {
    request.idempotencySignal?.throwIfAborted();
    // Pass the signal to cooperative downstream I/O, e.g. fetch(url, { signal }).
    // Persist effects transactionally or use downstream idempotency keys.
    return { sku: body.sku, id: 'example-order' };
  }
}
async function bootstrap() {
  const redis = createClient({
    url: process.env.REDIS_URL ?? 'redis://localhost:6393',
  });
  await redis.connect();
  const store = new RedisStore(redis, 'orders:idempotency:');
  // PostgreSQL alternative: deploy the schema explicitly before serving traffic.
  const pool = new Pool({ connectionString: process.env.DATABASE_URL });
  const postgres = new PostgresStore(pool, 'orders_idempotency');
  // await postgres.migrate(); // use in a deployment migration step
  void postgres;
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        store,
        namespace: 'orders-api',
        // Install your authentication guard first. The client cannot select its scope.
        scope: (request) => {
          const user = (request as AuthenticatedRequest).user;
          return user ? JSON.stringify([user.tenantId, user.id]) : '';
        },
      }),
    ],
    controllers: [OrdersController],
  })
  class AppModule {}
  const app = await NestFactory.create(AppModule);
  await app.listen(3000);
  async function shutdown() {
    await app.close();
    await redis.quit();
    await pool.end();
  }
  process.once('SIGINT', () => {
    void shutdown();
  });
  process.once('SIGTERM', () => {
    void shutdown();
  });
}
void bootstrap();
