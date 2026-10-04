import postgres from "postgres";

/**
 * The smallest connection surface `PostgresStore` needs. Two adapters exist:
 * the `postgres` driver for real servers and PGlite for in-process tests, so
 * the store's SQL is identical in both.
 */

export type SqlParam = string | number | boolean | null;
export type Row = Record<string, unknown>;

export interface Queryable {
  /** One statement with `$n` parameters. jsonb columns come back parsed. */
  query<R extends object = Row>(text: string, params?: SqlParam[]): Promise<R[]>;
  /** Several statements, no parameters (migrations). */
  exec(text: string): Promise<void>;
}

export interface SqlClient extends Queryable {
  /** Run `fn` in a transaction on one connection; rolls back if it throws. */
  transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

export interface PostgresClientOptions {
  /** Pool size. Default 10. */
  max?: number;
  /** Seconds before an idle connection is closed. Default 30. */
  idleTimeout?: number;
  /** Seconds to wait for a connection. Default 10. */
  connectTimeout?: number;
  /** Named prepared statements. Turn off behind a transaction-mode pooler (PgBouncer, Supabase :6543). Default true. */
  prepare?: boolean;
}

/** A pooled client on the `postgres` driver. */
export function postgresClient(url: string, options: PostgresClientOptions = {}): SqlClient {
  const sql = postgres(url, {
    max: options.max ?? 10,
    idle_timeout: options.idleTimeout ?? 30,
    connect_timeout: options.connectTimeout ?? 10,
    prepare: options.prepare ?? true,
    // `CREATE TABLE IF NOT EXISTS` and friends raise NOTICEs; library code does not print.
    onnotice: () => {},
  });
  const wrap = (s: postgres.Sql | postgres.TransactionSql): Queryable => ({
    async query<R extends object = Row>(text: string, params: SqlParam[] = []): Promise<R[]> {
      const rows = await s.unsafe(text, params);
      return [...rows] as unknown as R[];
    },
    async exec(text: string): Promise<void> {
      await s.unsafe(text);
    },
  });
  return {
    ...wrap(sql),
    async transaction<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> {
      return (await sql.begin((tx) => fn(wrap(tx)))) as T;
    },
    async close(): Promise<void> {
      await sql.end({ timeout: 5 });
    },
  };
}

/**
 * The parts of a PGlite instance the adapter uses, declared structurally so
 * `@electric-sql/pglite` stays a dev dependency.
 */
interface PGliteQueryable {
  query<R>(text: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(text: string): Promise<unknown>;
}

export interface PGliteLike extends PGliteQueryable {
  transaction<T>(fn: (tx: PGliteQueryable) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * A client on an in-process PGlite database. PGlite is a single connection
 * that serializes transactions, which is what tests want. With `shared`, the
 * caller keeps ownership and `close()` leaves the database open.
 */
export function pgliteClient(db: PGliteLike, options: { shared?: boolean } = {}): SqlClient {
  const wrap = (s: PGliteQueryable): Queryable => ({
    async query<R extends object = Row>(text: string, params: SqlParam[] = []): Promise<R[]> {
      return (await s.query<R>(text, params)).rows;
    },
    async exec(text: string): Promise<void> {
      await s.exec(text);
    },
  });
  return {
    ...wrap(db),
    transaction: <T>(fn: (tx: Queryable) => Promise<T>): Promise<T> => db.transaction((tx) => fn(wrap(tx))),
    async close(): Promise<void> {
      if (!options.shared) await db.close();
    },
  };
}
