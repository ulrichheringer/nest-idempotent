import {
  classify,
  validateDuration,
  validateResponse,
  type Claim,
  type IdempotencyStore,
  type StoredResponse,
} from './store';
/** Compatible with node-redis v5. Applications own connection/reconnection lifecycle. */
export interface RedisConnection {
  eval(
    script: string,
    options: { keys: string[]; arguments: string[] },
  ): Promise<unknown>;
}
const ACQUIRE = `
local value = redis.call('GET', KEYS[1])
if value then return value end
redis.call('SET', KEYS[1], ARGV[1], 'PX', ARGV[2])
return ''`;
const COMPLETE = `
local value = redis.call('GET', KEYS[1])
if not value then return 0 end
local record = cjson.decode(value)
if record.owner ~= ARGV[1] or record.response then return 0 end
record.response = ARGV[2]
redis.call('SET', KEYS[1], cjson.encode(record), 'PX', ARGV[3])
return 1`;
const RELEASE = `
local value = redis.call('GET', KEYS[1])
if value then
 local record = cjson.decode(value)
 if record.owner == ARGV[1] and not record.response then redis.call('DEL', KEYS[1]) end
end
return 0`;
/** Single-key Lua operations work with Redis Cluster and Valkey. */
export class RedisStore implements IdempotencyStore {
  constructor(
    private readonly connection: RedisConnection,
    private readonly prefix = 'nest-idempotent:',
  ) {
    if (!prefix) throw new Error('Redis namespace must not be empty');
  }
  async acquire(
    key: string,
    fingerprint: string,
    owner: string,
    leaseMs: number,
  ): Promise<Claim> {
    validateDuration(leaseMs);
    const value = await this.connection.eval(ACQUIRE, {
      keys: [this.prefix + key],
      arguments: [JSON.stringify({ fingerprint, owner }), String(leaseMs)],
    });
    if (value === '') return { kind: 'acquired' };
    const record = JSON.parse(String(value)) as {
      fingerprint: string;
      owner: string;
      response?: string;
    };
    return classify(
      {
        ...record,
        response:
          record.response === undefined
            ? undefined
            : validateResponse(JSON.parse(record.response) as unknown),
      },
      fingerprint,
    );
  }
  async complete(
    key: string,
    owner: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<boolean> {
    validateDuration(ttlMs);
    validateResponse(response);
    return (
      (await this.connection.eval(COMPLETE, {
        keys: [this.prefix + key],
        arguments: [owner, JSON.stringify(response), String(ttlMs)],
      })) === 1
    );
  }
  async release(key: string, owner: string): Promise<void> {
    await this.connection.eval(RELEASE, {
      keys: [this.prefix + key],
      arguments: [owner],
    });
  }
}
