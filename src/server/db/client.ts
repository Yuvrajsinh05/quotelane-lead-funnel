import { drizzle, type PostgresJsDatabase } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import * as schema from "./schema";
import { getConfig } from "../config";

export type Db = PostgresJsDatabase<typeof schema>;

type Holder = { sql: postgres.Sql; db: Db; url: string };
const g = globalThis as unknown as { __quotelaneDb?: Holder };

export function createDb(url: string, opts: { max?: number } = {}): Holder {
  const sql = postgres(url, {
    // Serverless: few connections per instance; the provider's pooler does the fan-in.
    max: opts.max ?? 5,
    idle_timeout: 20,
    connect_timeout: 10,
    // Transaction-mode poolers (pgbouncer etc.) don't support named prepared statements.
    prepare: false,
    onnotice: () => {},
  });
  return { sql, db: drizzle(sql, { schema }), url };
}

/**
 * One pool per server instance, cached on globalThis so Next's dev hot-reload doesn't
 * open a new pool on every edit.
 */
export function getDb(): Db {
  const url = getConfig().DATABASE_URL;
  if (!g.__quotelaneDb || g.__quotelaneDb.url !== url) g.__quotelaneDb = createDb(url);
  return g.__quotelaneDb.db;
}

export { schema };
