/** A JSON response stored before the original HTTP response is sent. */
export interface StoredResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
}
export type Claim =
  | { kind: 'acquired' }
  | { kind: 'busy' }
  | { kind: 'conflict' }
  | { kind: 'replay'; response: StoredResponse };
/** All mutations must be atomic and owner/expiry checked by the storage server. */
export interface IdempotencyStore {
  acquire(
    key: string,
    fingerprint: string,
    owner: string,
    leaseMs: number,
  ): Promise<Claim>;
  complete(
    key: string,
    owner: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<boolean>;
  release(key: string, owner: string): Promise<void>;
}
export interface RecordValue {
  fingerprint: string;
  owner: string;
  response?: StoredResponse;
}
export function classify(record: RecordValue, fingerprint: string): Claim {
  if (
    typeof record.fingerprint !== 'string' ||
    typeof record.owner !== 'string'
  )
    throw new Error('Corrupt idempotency record');
  if (record.fingerprint !== fingerprint) return { kind: 'conflict' };
  return record.response
    ? {
        kind: 'replay',
        response: structuredClone(validateResponse(record.response)),
      }
    : { kind: 'busy' };
}
/** Development only: process-local storage, unsuitable for multiple replicas. */
export class MemoryStore implements IdempotencyStore {
  private readonly records = new Map<
    string,
    RecordValue & { expires: number }
  >();
  async acquire(
    key: string,
    fingerprint: string,
    owner: string,
    leaseMs: number,
  ): Promise<Claim> {
    validateDuration(leaseMs);
    const value = this.records.get(key);
    if (value && value.expires > Date.now())
      return classify(value, fingerprint);
    this.records.set(key, {
      fingerprint,
      owner,
      expires: Date.now() + leaseMs,
    });
    return { kind: 'acquired' };
  }
  async complete(
    key: string,
    owner: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<boolean> {
    validateDuration(ttlMs);
    validateResponse(response);
    const value = this.records.get(key);
    if (
      !value ||
      value.owner !== owner ||
      value.response ||
      value.expires <= Date.now()
    )
      return false;
    this.records.set(key, {
      ...value,
      response: structuredClone(response),
      expires: Date.now() + ttlMs,
    });
    return true;
  }
  async release(key: string, owner: string): Promise<void> {
    const value = this.records.get(key);
    if (value?.owner === owner && !value.response) this.records.delete(key);
  }
}

/** Validate persisted envelopes before replay; corrupted storage fails closed. */
export function validateResponse(value: unknown): StoredResponse {
  if (!value || typeof value !== 'object')
    throw new Error('Corrupt stored response');
  const response = value as StoredResponse;
  if (
    !Number.isInteger(response.status) ||
    response.status < 200 ||
    response.status >= 500 ||
    !response.headers ||
    typeof response.headers !== 'object' ||
    Array.isArray(response.headers) ||
    !Object.hasOwn(response, 'body') ||
    Object.entries(response.headers).some(
      ([name, header]) =>
        !/^[a-zA-Z0-9!#$%&'*+.^_`|~-]+$/.test(name) ||
        typeof header !== 'string' ||
        /[\r\n]/.test(header),
    )
  )
    throw new Error('Corrupt stored response');
  return response;
}
export function validateDuration(value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0)
    throw new Error('Duration must be a positive safe integer');
}
