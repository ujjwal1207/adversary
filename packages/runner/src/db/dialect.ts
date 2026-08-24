/**
 * Storage configuration.
 *
 * SQLite is the default because a stranger must be able to clone this repo and
 * run the full corpus with no services running. Postgres is supported through a
 * single config change, and CI migrates and runs against both so the two cannot
 * quietly diverge.
 */

export type Dialect = 'sqlite' | 'postgres';

export const DIALECTS: readonly Dialect[] = ['sqlite', 'postgres'];

export type DbConfig =
  | { dialect: 'sqlite'; path: string }
  | { dialect: 'postgres'; url: string };

export const DEFAULT_SQLITE_PATH = './adversary.sqlite';

/** An in-memory SQLite database, used by tests so they leave nothing behind. */
export const SQLITE_MEMORY = ':memory:';

export class DbConfigError extends Error {
  override readonly name = 'DbConfigError';
}

/**
 * Reads storage config from the environment.
 *
 * Absent configuration is not an error - it selects SQLite at the default path.
 * Present but incoherent configuration is an error, and it is raised here
 * rather than at first query, so a typo in `ADVERSARY_DB_DIALECT` fails before
 * anything has been written.
 */
export function dbConfigFromEnv(env: NodeJS.ProcessEnv = process.env): DbConfig {
  const raw = env['ADVERSARY_DB_DIALECT']?.trim().toLowerCase();

  if (raw === undefined || raw === '' || raw === 'sqlite') {
    return {
      dialect: 'sqlite',
      path: env['ADVERSARY_SQLITE_PATH']?.trim() || DEFAULT_SQLITE_PATH,
    };
  }

  if (raw === 'postgres' || raw === 'postgresql' || raw === 'pg') {
    const url = env['ADVERSARY_PG_URL']?.trim();
    if (!url) {
      throw new DbConfigError(
        'ADVERSARY_DB_DIALECT=postgres requires ADVERSARY_PG_URL to be set. ' +
          'See .env.example.',
      );
    }
    return { dialect: 'postgres', url };
  }

  throw new DbConfigError(
    `Unknown ADVERSARY_DB_DIALECT "${raw}". Expected "sqlite" or "postgres".`,
  );
}

export function describeConfig(config: DbConfig): string {
  return config.dialect === 'sqlite'
    ? `sqlite:${config.path}`
    : `postgres:${redactUrl(config.url)}`;
}

/** Never print a connection string with its password in it. */
export function redactUrl(url: string): string {
  try {
    const parsed = new URL(url);
    if (parsed.password) parsed.password = '***';
    return parsed.toString();
  } catch {
    return '<unparseable connection string>';
  }
}
