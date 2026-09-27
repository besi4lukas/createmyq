import { Client } from "pg";

/**
 * Run `fn` with a Postgres client opened for this request, through Hyperdrive.
 *
 * Never cache a client in module scope: a connection can't be reused across
 * requests in Workers. Hyperdrive keeps the real connection pool to Neon, so a
 * fresh client per request is cheap. The client is closed after `fn` settles,
 * in the background via waitUntil so it doesn't delay the response.
 */
export async function withDb<T>(
  env: Env,
  ctx: Pick<ExecutionContext, "waitUntil">,
  fn: (db: Client) => Promise<T>,
): Promise<T> {
  const client = new Client({ connectionString: env.HYPERDRIVE.connectionString });
  try {
    await client.connect();
    return await fn(client);
  } finally {
    ctx.waitUntil(client.end().catch(() => {}));
  }
}
