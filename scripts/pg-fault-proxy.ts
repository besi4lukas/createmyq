/**
 * Dev-only fault injection for the session flush (STM-10). NOT part of the
 * Worker: it's a local TCP proxy between `wrangler dev`'s Hyperdrive and a
 * throwaway Neon branch, so the Worker has no fault hooks of its own and
 * nothing in production can trigger one.
 *
 *   UPSTREAM_DATABASE_URL="$(neon connection-string <throwaway-branch>)" npx tsx scripts/pg-fault-proxy.ts
 *
 * Then run wrangler dev with the local Hyperdrive pointed at the proxy (same
 * user, password and database as the upstream URL, plain TCP to localhost):
 *
 *   CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE=postgresql://<user>:<pw>@127.0.0.1:6543/<db>?sslmode=disable
 *
 * Arm a fault over HTTP; each one fires on the next N session flushes only,
 * and every other query (sign-in, quiz assembly) passes through untouched:
 *
 *   curl -X POST 'localhost:6544/fail-flush?times=2'   drop the connection at INSERT INTO "sessions"
 *                                                      (mid-transaction: Postgres rolls back)
 *   curl -X POST 'localhost:6544/lose-commit?times=1'  let the flush COMMIT, then drop the connection
 *                                                      before the Worker hears back (the "crash
 *                                                      between commit and delete" case)
 *   curl -X POST 'localhost:6544/hang-flush?times=1'   swallow INSERT INTO "sessions" and never answer
 *                                                      (a hung connection; the flush must time out)
 *   curl localhost:6544/                               remaining counts
 *   curl -X POST localhost:6544/reset
 */
import { createServer as createHttpServer } from "node:http";
import { connect, createServer, type Socket } from "node:net";
import { connect as tlsConnect } from "node:tls";

const upstream = process.env.UPSTREAM_DATABASE_URL;
if (!upstream) {
  console.error("Set UPSTREAM_DATABASE_URL to a throwaway Neon branch (never production).");
  process.exit(1);
}
const { hostname: host, port } = new URL(upstream);
const upstreamPort = Number(port || 5432);
const PORT = 6543;
const CONTROL_PORT = 6544;

const faults = { failFlush: 0, loseCommit: 0, hangFlush: 0 };

/** SSLRequest / GSSENCRequest: 8 bytes, length 8, then a magic code. */
const isEncryptionRequest = (b: Buffer) =>
  b.length >= 8 && b.readInt32BE(0) === 8 && [80877103, 80877104].includes(b.readInt32BE(4));

/** Open a TLS connection to Neon the way libpq does (SSLRequest, then TLS with SNI). */
function openUpstream(): Promise<Socket> {
  return new Promise((resolve, reject) => {
    const raw = connect(upstreamPort, host);
    raw.once("error", reject);
    raw.once("connect", () => {
      const req = Buffer.alloc(8);
      req.writeInt32BE(8, 0);
      req.writeInt32BE(80877103, 4);
      raw.write(req);
    });
    raw.once("data", (b) => {
      if (b[0] !== 0x53) return reject(new Error("upstream refused TLS"));
      const tls = tlsConnect({ socket: raw, servername: host }, () => resolve(tls));
      tls.once("error", reject);
    });
  });
}

createServer((client) => {
  let server: Socket | undefined;
  let flushing = false; // this connection has sent INSERT INTO "sessions"
  let sentCommit = false;
  let hung = false;
  const kill = () => {
    client.destroy();
    server?.destroy();
  };
  client.on("error", kill);

  client.on("data", async function onFirst(first: Buffer) {
    if (isEncryptionRequest(first)) return void client.write("N"); // stay plain; wait for the startup
    client.off("data", onFirst);
    client.pause();
    try {
      server = await openUpstream();
    } catch (err) {
      console.error("upstream:", (err as Error).message);
      return kill();
    }
    server.on("error", kill);
    server.on("close", () => client.destroy());
    client.on("close", () => server?.destroy());
    server.write(first);

    client.on("data", (chunk: Buffer) => {
      const text = chunk.toString("latin1");
      if (text.includes('insert into "sessions"')) {
        flushing = true;
        if (faults.failFlush > 0) {
          faults.failFlush--;
          console.log(`[fault] fail-flush: dropped the connection at INSERT INTO sessions (${faults.failFlush} left)`);
          return kill();
        }
        if (faults.hangFlush > 0) {
          faults.hangFlush--;
          hung = true;
          console.log(`[fault] hang-flush: swallowing this connection from INSERT INTO sessions on (${faults.hangFlush} left)`);
        }
      }
      if (hung) return;
      if (flushing && /\bcommit\b/i.test(text)) sentCommit = true;
      server!.write(chunk);
    });
    server.on("data", (chunk: Buffer) => {
      if (sentCommit && faults.loseCommit > 0 && chunk.toString("latin1").includes("COMMIT\0")) {
        faults.loseCommit--;
        console.log(`[fault] lose-commit: Postgres committed, reply dropped (${faults.loseCommit} left)`);
        return kill();
      }
      client.write(chunk);
    });
    client.resume();
  });
}).listen(PORT, "127.0.0.1", () => console.log(`pg fault proxy on 127.0.0.1:${PORT} → ${host}:${upstreamPort}`));

createHttpServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://x");
  const times = Number(url.searchParams.get("times") ?? 1);
  if (req.method === "POST" && url.pathname === "/fail-flush") faults.failFlush = times;
  if (req.method === "POST" && url.pathname === "/lose-commit") faults.loseCommit = times;
  if (req.method === "POST" && url.pathname === "/hang-flush") faults.hangFlush = times;
  if (req.method === "POST" && url.pathname === "/reset") Object.assign(faults, { failFlush: 0, loseCommit: 0, hangFlush: 0 });
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify(faults) + "\n");
}).listen(CONTROL_PORT, "127.0.0.1", () => console.log(`control on 127.0.0.1:${CONTROL_PORT}`));
