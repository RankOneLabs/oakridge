import type { Client } from "pg";

export async function dropScratchDatabase(admin: Client, name: string): Promise<void> {
  // A pool can finish closing before PostgreSQL removes its last backend.
  // FORCE would send a FATAL error to that client during shutdown.
  const deadline = Date.now() + 5_000;
  for (;;) {
    try { await admin.query(`DROP DATABASE IF EXISTS ${name}`); return; }
    catch (cause) {
      if ((cause as { code?: string }).code !== "55006" || Date.now() >= deadline) throw cause;
      await Bun.sleep(20);
    }
  }
}
