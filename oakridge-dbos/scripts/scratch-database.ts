/**
 * Scratch databases on a test server, shared by the record generator and the
 * test fixture. A pool's `end()` resolves before its sockets close, so a
 * forced drop issued straight after it can terminate a connection that is
 * still closing, and pg raises that termination as an unhandled error. The
 * drop waits for the database's sessions to leave first.
 */
import { Client } from "pg";

const SESSION_WAIT_MS = 10_000;
const SESSION_POLL_MS = 25;

export interface ScratchDatabase { readonly url: string; drop(): Promise<void> }

export async function createScratchDatabase(server_url: string, name: string): Promise<ScratchDatabase> {
  await withAdmin(server_url, (admin) => admin.query(`CREATE DATABASE ${name}`));
  const url = new URL(server_url);
  url.pathname = `/${name}`;
  return { url: url.href, drop: () => withAdmin(server_url, async (admin) => {
    await awaitNoSessions(admin, name);
    await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  }) };
}

async function withAdmin<Value>(server_url: string, operation: (admin: Client) => Promise<Value>): Promise<Value> {
  const admin = new Client({ connectionString: server_url });
  await admin.connect();
  try { return await operation(admin); } finally { await admin.end(); }
}

/** Sessions still open after the wait are left to the forced drop. */
async function awaitNoSessions(admin: Client, name: string): Promise<void> {
  const deadline = Date.now() + SESSION_WAIT_MS;
  while (Date.now() < deadline) {
    const sessions = await admin.query<{ count: string }>("SELECT count(*) FROM pg_stat_activity WHERE datname = $1", [name]);
    if (sessions.rows[0]?.count === "0") return;
    await Bun.sleep(SESSION_POLL_MS);
  }
}
