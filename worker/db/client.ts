import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres";
import { Client } from "pg";
import * as schema from "./schema";

export type Db = NodePgDatabase<typeof schema> & { $client: Client };

/**
 * Run `fn` with a Drizzle instance over a Postgres client opened for this
 * request, through Hyperdrive. The raw `pg` client is on `db.$client`.
 *
 * Never cache a client in module scope: a connection can't be reused across
 * requests in Workers. Hyperdrive keeps the real connection pool to Neon, so a
 * fresh client per request is cheap. The client is closed after `fn` settles,
 * in the background via waitUntil so it doesn't delay the response.
 */
export async function withDb<T>(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fn: (db: Db) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    await client.connect();
    return await fn(drizzle({ client, schema }));
  } finally {
    ctx.waitUntil(client.end().catch(() => {}));
  }
}
