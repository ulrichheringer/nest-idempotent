import {
  Body,
  Controller,
  HttpCode,
  HttpException,
  Module,
  Post,
  Req,
  Res,
} from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import {
  IdempotencyModule,
  Idempotent,
  MemoryStore,
  type IdempotencyRequest,
  type IdempotencyStore,
} from '../src';
interface Response {
  setHeader(name: string, value: string): void;
}
@Controller()
class Orders {
  calls = 0;
  @Post('orders')
  @Idempotent({ ttlMs: 90, leaseMs: 1000, timeoutMs: 500 })
  async create(
    @Body() body: { fail?: boolean; delay?: number },
    @Res({ passthrough: true }) response: Response,
  ): Promise<unknown> {
    this.calls++;
    await new Promise((resolve) => setTimeout(resolve, body.delay ?? 0));
    if (body.fail) throw new HttpException('failed', 422);
    response.setHeader('location', '/orders/42');
    response.setHeader('set-cookie', 'private=secret');
    return {
      calls: this.calls,
      payload: [[], {}, Number.MAX_SAFE_INTEGER, 1.2345678901234567],
    };
  }
  @Post('timeout')
  @HttpCode(200)
  @Idempotent({ leaseMs: 400, timeoutMs: 25 })
  async slow(@Req() request: IdempotencyRequest): Promise<unknown> {
    this.calls++;
    return new Promise((_, reject) =>
      request.idempotencySignal!.addEventListener(
        'abort',
        () => reject(new Error('aborted')),
        { once: true },
      ),
    );
  }
  @Post('plain') plain(): string {
    return 'plain';
  }
}
export async function appFor(store: IdempotencyStore = new MemoryStore()) {
  @Module({
    imports: [
      IdempotencyModule.forRoot({
        store,
        scope: (request) => {
          // Test-only authenticated context simulation. Production must use a guard/session.
          const tenant = request.headers['x-test-tenant'];
          return typeof tenant === 'string' ? tenant : '';
        },
      }),
    ],
    controllers: [Orders],
  })
  class App {}
  const app = await NestFactory.create(App, { logger: false });
  await app.listen(0, '127.0.0.1');
  const base = await app.getUrl();
  const send = (
    key: string | undefined,
    body: unknown = {},
    path = '/orders',
    tenant = 'a',
  ) =>
    fetch(base + path, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-test-tenant': tenant,
        ...(key === undefined ? {} : { 'idempotency-key': key }),
      },
      body: JSON.stringify(body),
    });
  return { app, send, controller: app.get(Orders) };
}
