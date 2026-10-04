import {
  classify,
  validateDuration,
  validateResponse,
  type Claim,
  type IdempotencyStore,
  type RecordValue,
  type StoredResponse,
} from './store';
/** Compatible with pg Pool or Client; no driver is loaded by this library. */
export interface PgConnection {
  query(
    sql: string,
    values?: unknown[],
  ): Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
}
/** PostgreSQL uses database time and a unique key for cross-process reservations. */
export class PostgresStore implements IdempotencyStore {
  private readonly table: string;
  constructor(
    private readonly connection: PgConnection,
    table = 'nest_idempotent',
  ) {
    if (!/^[a-z_][a-z0-9_]*$/.test(table))
      throw new Error('Invalid PostgreSQL table name');
    this.table = `"${table}"`;
  }
  /** Run explicitly at deployment, never implicitly on an HTTP request. */
  async migrate(): Promise<void> {
    await this.connection.query(`CREATE TABLE IF NOT EXISTS ${this.table} (
      key text PRIMARY KEY, fingerprint text NOT NULL, owner text NOT NULL,
      response jsonb, expires_at timestamptz NOT NULL)`);
    await this.connection.query(
      `CREATE INDEX IF NOT EXISTS ${this.table.replaceAll('"', '')}_expiry ON ${this.table} (expires_at)`,
    );
  }
  async acquire(
    key: string,
    fingerprint: string,
    owner: string,
    leaseMs: number,
  ): Promise<Claim> {
    validateDuration(leaseMs);
    for (let attempt = 0; attempt < 3; attempt++) {
      const inserted = await this.connection.query(
        `INSERT INTO ${this.table} AS current (key, fingerprint, owner, expires_at)
        VALUES ($1, $2, $3, clock_timestamp() + $4 * interval '1 millisecond')
        ON CONFLICT (key) DO UPDATE SET fingerprint = EXCLUDED.fingerprint,
          owner = EXCLUDED.owner, response = NULL, expires_at = EXCLUDED.expires_at
        WHERE current.expires_at <= clock_timestamp() RETURNING key`,
        [key, fingerprint, owner, leaseMs],
      );
      if (inserted.rowCount === 1) return { kind: 'acquired' };
      const found = await this.connection.query(
        `SELECT fingerprint, owner, response FROM ${this.table} WHERE key = $1 AND expires_at > clock_timestamp()`,
        [key],
      );
      if (found.rows[0]) {
        const row = found.rows[0];
        return classify(
          {
            fingerprint: String(row.fingerprint),
            owner: String(row.owner),
            response: (row.response ?? undefined) as RecordValue['response'],
          },
          fingerprint,
        );
      }
    }
    throw new Error('Idempotency reservation changed repeatedly');
  }
  async complete(
    key: string,
    owner: string,
    response: StoredResponse,
    ttlMs: number,
  ): Promise<boolean> {
    validateDuration(ttlMs);
    validateResponse(response);
    const result = await this.connection.query(
      `UPDATE ${this.table} SET response = $3::jsonb, expires_at = clock_timestamp() + $4 * interval '1 millisecond'
      WHERE key = $1 AND owner = $2 AND response IS NULL AND expires_at > clock_timestamp()`,
      [key, owner, JSON.stringify(response), ttlMs],
    );
    return result.rowCount === 1;
  }
  async release(key: string, owner: string): Promise<void> {
    await this.connection.query(
      `DELETE FROM ${this.table} WHERE key = $1 AND owner = $2 AND response IS NULL`,
      [key, owner],
    );
  }
  /** Schedule periodically; expiry is enforced even before cleanup. */
  async prune(): Promise<number> {
    return (
      (
        await this.connection.query(
          `DELETE FROM ${this.table} WHERE expires_at <= clock_timestamp()`,
        )
      ).rowCount ?? 0
    );
  }
}
