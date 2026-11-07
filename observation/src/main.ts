import { createApp } from "./http/app";
import { NO_CONFIGURED_GRADERS } from "./http/health";
import { credentialsFromEnv } from "./http/ingest-auth";
import { oakridgeProfile } from "./producers/oakridge/profile";
import { openDatabase } from "./storage/database";
import { migrateEmptyDatabase } from "./storage/migrate";

/** The composition root: the one place that names a producer and hands it to generic code. */
export async function startObservation(env: NodeJS.ProcessEnv = process.env): Promise<{
  readonly port: number; stop(): Promise<void> }> {
  if (!env.OBSERVATION_DATABASE_URL) throw new Error("OBSERVATION_DATABASE_URL is required");
  const credentials = credentialsFromEnv(env);
  const db = openDatabase(env.OBSERVATION_DATABASE_URL);
  try {
    await migrateEmptyDatabase(db);
    // Nothing registers a grader at startup yet, and health reports exactly that.
    const app = createApp({ db, credentials, profile: oakridgeProfile, grader_capability: () => NO_CONFIGURED_GRADERS });
    const server = Bun.serve({ fetch: app.fetch, hostname: env.OBSERVATION_HOST ?? "127.0.0.1", port: Number(env.OBSERVATION_PORT ?? 8791) });
    return { port: server.port ?? Number(env.OBSERVATION_PORT ?? 8791),
      stop: async () => { server.stop(); await db.destroy(); } };
  } catch (error) { await db.destroy(); throw error; }
}

if (import.meta.main) await startObservation();
