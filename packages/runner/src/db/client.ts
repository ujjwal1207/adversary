/**
 * Connection handles for the two supported dialects.
 *
 * The drivers are loaded with dynamic `import()` rather than a static one so
 * that choosing Postgres does not require `better-sqlite3` to have compiled,
 * and choosing SQLite does not open a `pg` pool. One dialect failing to install
 * must not take the other down with it.
 */

import type { DbConfig } from './dialect.js';

/**
 * A live connection plus the primitives the migrator needs.
 *
 * Deliberately minimal. Query building is Drizzle's job (see `schema.*.ts`);
 * this interface exists only so one migrator can drive a synchronous SQLite
 * driver and an asynchronous Postgres pool without knowing which it has.
 */
export interface DbHandle {
  readonly dialect: DbConfig['dialect'];
  readonly describe: string;
  exec(sql: string): Promise<void>;
  /** Parameterised write. Placeholders differ by dialect - see `placeholder`. */
  run(sql: string, params?: unknown[]): Promise<void>;
  all<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  transaction<T>(fn: () => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export async function openDb(config: DbConfig): Promise<DbHandle> {
  return config.dialect === 'sqlite' ? openSqlite(config) : openPostgres(config);
}

async function openSqlite(
  config: Extract<DbConfig, { dialect: 'sqlite' }>,
): Promise<DbHandle> {
  const { default: Database } = await import('better-sqlite3');
  const raw = new Database(config.path);

  // Off by default in SQLite, and this schema leans on FKs from money_actions,
  // trajectory_events and verdicts back to runs.
  raw.pragma('foreign_keys = ON');
  // WAL keeps a reader (the report generator) from blocking the writer.
  if (config.path !== ':memory:') raw.pragma('journal_mode = WAL');

  return {
    dialect: 'sqlite',
    describe: `sqlite:${config.path}`,
    async exec(sql) {
      raw.exec(sql);
    },
    async run(sql: string, params: unknown[] = []) {
      raw.prepare(sql).run(...(params as never[]));
    },
    async all<T>(sql: string, params: unknown[] = []) {
      return raw.prepare(sql).all(...(params as never[])) as T[];
    },
    async transaction<T>(fn: () => Promise<T>) {
      // better-sqlite3's own `transaction()` helper is synchronous and cannot
      // wrap an async callback, so the statements are issued directly.
      raw.exec('BEGIN');
      try {
        const out = await fn();
        raw.exec('COMMIT');
        return out;
      } catch (err) {
        raw.exec('ROLLBACK');
        throw err;
      }
    },
    async close() {
      raw.close();
    },
  };
}

async function openPostgres(
  config: Extract<DbConfig, { dialect: 'postgres' }>,
): Promise<DbHandle> {
  const pg = await import('pg');
  const pool = new pg.default.Pool({ connectionString: config.url, max: 4 });
  const client = await pool.connect();
  const { redactUrl } = await import('./dialect.js');

  return {
    dialect: 'postgres',
    describe: `postgres:${redactUrl(config.url)}`,
    async exec(sql) {
      await client.query(sql);
    },
    async run(sql: string, params: unknown[] = []) {
      await client.query(sql, params);
    },
    async all<T>(sql: string, params: unknown[] = []) {
      const res = await client.query(sql, params);
      return res.rows as T[];
    },
    async transaction<T>(fn: () => Promise<T>) {
      await client.query('BEGIN');
      try {
        const out = await fn();
        await client.query('COMMIT');
        return out;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      }
    },
    async close() {
      client.release();
      await pool.end();
    },
  };
}
