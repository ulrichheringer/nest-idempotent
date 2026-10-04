import { createHash, randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  GatewayTimeoutException,
  Inject,
  Injectable,
  Module,
  ServiceUnavailableException,
  SetMetadata,
  type CallHandler,
  type DynamicModule,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { APP_INTERCEPTOR, Reflector } from '@nestjs/core';
import {
  defer,
  firstValueFrom,
  timeout,
  TimeoutError,
  type Observable,
} from 'rxjs';
import {
  validateResponse,
  type IdempotencyStore,
  type StoredResponse,
} from './store';

/** Structural Express request contract; guards may attach authenticated data. */
export interface IdempotencyRequest {
  method: string;
  originalUrl: string;
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  query?: unknown;
  idempotencySignal?: AbortSignal;
}
interface HttpResponse {
  statusCode: number;
  headersSent: boolean;
  status(code: number): unknown;
  setHeader(name: string, value: string): unknown;
  getHeaders(): Record<string, string | number | string[] | undefined>;
}
export interface EndpointOptions {
  ttlMs?: number;
  leaseMs?: number;
  timeoutMs?: number;
}
export interface IdempotencyOptions extends EndpointOptions {
  store: IdempotencyStore;
  /** Derive from verified authentication/authorization context, never an untrusted tenant header. */
  scope: (request: IdempotencyRequest) => string | Promise<string>;
  /** Server-owned application namespace. */
  namespace?: string;
  maxResponseBytes?: number;
  /** Headers affecting handler semantics; defaults to content-type and accept. */
  varyHeaders?: string[];
}
const OPTIONS = Symbol('nest-idempotent.options');
const ENDPOINT = Symbol('nest-idempotent.endpoint');
/** Protect an HTTP JSON endpoint. Missing keys are rejected instead of bypassing protection. */
export const Idempotent = (
  options: EndpointOptions = {},
): MethodDecorator & ClassDecorator => SetMetadata(ENDPOINT, options);

/** Stable JSON encoding: object keys sorted; array order is significant. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'string' || typeof value === 'boolean')
    return JSON.stringify(value);
  if (typeof value === 'number' && Number.isFinite(value))
    return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype ||
      Object.getPrototypeOf(value) === null)
  ) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
      .join(',')}}`;
  }
  throw new BadRequestException(
    'Idempotent endpoints require JSON request values',
  );
}
const hash = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
function duration(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error(`${name} must be a positive safe integer`);
  return value;
}
function timings(options: EndpointOptions): Required<EndpointOptions> {
  const ttlMs = duration(options.ttlMs ?? 86_400_000, 'ttlMs');
  const leaseMs = duration(options.leaseMs ?? 60_000, 'leaseMs');
  const timeoutMs = duration(options.timeoutMs ?? 30_000, 'timeoutMs');
  if (timeoutMs >= leaseMs)
    throw new Error('timeoutMs must be smaller than leaseMs');
  return { ttlMs, leaseMs, timeoutMs };
}
const SAFE_HEADERS = new Set([
  'content-type',
  'content-language',
  'location',
  'etag',
  'cache-control',
]);

@Injectable()
export class IdempotencyInterceptor implements NestInterceptor<
  unknown,
  unknown
> {
  constructor(
    @Inject(OPTIONS) private readonly options: IdempotencyOptions,
    private readonly reflector: Reflector,
  ) {}
  intercept(
    context: ExecutionContext,
    next: CallHandler<unknown>,
  ): Observable<unknown> {
    const controllerOptions = this.reflector.get<EndpointOptions | undefined>(
      ENDPOINT,
      context.getClass(),
    );
    const handlerOptions = this.reflector.get<EndpointOptions | undefined>(
      ENDPOINT,
      context.getHandler(),
    );
    if (!controllerOptions && !handlerOptions) return next.handle();
    const endpoint = { ...controllerOptions, ...handlerOptions };
    return defer(() => this.execute(context, next, endpoint));
  }
  private async execute(
    context: ExecutionContext,
    next: CallHandler<unknown>,
    endpoint: EndpointOptions,
  ): Promise<unknown> {
    if (context.getType() !== 'http')
      throw new Error('Idempotent only supports HTTP');
    const request = context.switchToHttp().getRequest<IdempotencyRequest>();
    const response = context.switchToHttp().getResponse<HttpResponse>();
    const key = request.headers['idempotency-key'];
    if (typeof key !== 'string' || !/^[\x21-\x7e]{1,200}$/.test(key))
      throw new BadRequestException(
        'Idempotency-Key must contain 1-200 printable non-space ASCII characters',
      );
    const scope = await this.options.scope(request);
    if (typeof scope !== 'string' || !scope.trim())
      throw new BadRequestException('A trusted idempotency scope is required');
    const { ttlMs, leaseMs, timeoutMs } = timings({
      ...this.options,
      ...endpoint,
    });
    const identity = hash(
      canonicalJson([this.options.namespace ?? 'default', scope, key]),
    );
    const varyingHeaders = (
      this.options.varyHeaders ?? ['content-type', 'accept']
    ).map((name) => [
      name.toLowerCase(),
      request.headers[name.toLowerCase()] ?? null,
    ]);
    const fingerprint = hash(
      canonicalJson([
        request.method.toUpperCase(),
        request.originalUrl.split('?')[0],
        request.query ?? {},
        request.body ?? null,
        varyingHeaders,
      ]),
    );
    const owner = randomUUID();
    let claim;
    try {
      claim = await this.options.store.acquire(
        identity,
        fingerprint,
        owner,
        leaseMs,
      );
    } catch {
      throw new ServiceUnavailableException('Idempotency storage unavailable');
    }
    if (claim.kind === 'conflict')
      throw new ConflictException(
        'Idempotency-Key was used for a different request',
      );
    if (claim.kind === 'busy')
      throw new ConflictException('An execution is already in progress');
    if (claim.kind === 'replay') {
      try {
        validateResponse(claim.response);
      } catch {
        throw new ServiceUnavailableException('Corrupt idempotency response');
      }
      response.status(claim.response.status);
      for (const [name, value] of Object.entries(claim.response.headers))
        if (SAFE_HEADERS.has(name)) response.setHeader(name, value);
      response.setHeader('idempotency-replayed', 'true');
      return claim.response.body;
    }
    const controller = new AbortController();
    request.idempotencySignal = controller.signal;
    let timedOut = false;
    let handlerFinished = false;
    try {
      const body = await firstValueFrom(
        next.handle().pipe(timeout({ first: timeoutMs })),
      );
      handlerFinished = true;
      if (response.headersSent || response.statusCode >= 500)
        throw new ServiceUnavailableException('Response cannot be persisted');
      let serialized: string | undefined;
      try {
        serialized = JSON.stringify(body ?? null);
      } catch {
        throw new ServiceUnavailableException(
          'Response is not JSON serializable',
        );
      }
      if (
        serialized === undefined ||
        Buffer.byteLength(serialized) >
          (this.options.maxResponseBytes ?? 1_048_576)
      )
        throw new ServiceUnavailableException(
          'Response exceeds idempotency storage limit',
        );
      const headers: Record<string, string> = {};
      for (const [name, value] of Object.entries(response.getHeaders()))
        if (SAFE_HEADERS.has(name.toLowerCase()) && typeof value === 'string')
          headers[name.toLowerCase()] = value;
      const stored: StoredResponse = {
        status: response.statusCode,
        headers,
        body: JSON.parse(serialized) as unknown,
      };
      let completed;
      try {
        completed = await this.options.store.complete(
          identity,
          owner,
          stored,
          ttlMs,
        );
      } catch {
        throw new ServiceUnavailableException(
          'Idempotency result could not be persisted',
        );
      }
      if (!completed)
        throw new ServiceUnavailableException('Idempotency lease lost');
      response.setHeader('idempotency-replayed', 'false');
      return stored.body;
    } catch (error) {
      timedOut = error instanceof TimeoutError;
      controller.abort(error);
      // Retain uncertain executions until lease expiry: cancellation is cooperative.
      // A completed effect whose result could not persist must not be retried immediately.
      if (!timedOut && !handlerFinished) {
        try {
          await this.options.store.release(identity, owner);
        } catch {
          throw new ServiceUnavailableException('Idempotency cleanup failed');
        }
      }
      if (timedOut)
        throw new GatewayTimeoutException('Idempotent execution timed out');
      throw error;
    }
  }
}

@Module({})
export class IdempotencyModule {
  static forRoot(options: IdempotencyOptions): DynamicModule {
    timings(options);
    duration(options.maxResponseBytes ?? 1_048_576, 'maxResponseBytes');
    if (
      options.varyHeaders?.some(
        (name) => !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name),
      )
    )
      throw new Error('Invalid varyHeaders name');
    if (typeof options.scope !== 'function')
      throw new Error('A trusted scope resolver is required');
    return {
      module: IdempotencyModule,
      providers: [
        { provide: OPTIONS, useValue: options },
        IdempotencyInterceptor,
        { provide: APP_INTERCEPTOR, useExisting: IdempotencyInterceptor },
      ],
      exports: [IdempotencyInterceptor],
    };
  }
}
