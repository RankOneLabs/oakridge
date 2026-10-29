import { createApp } from "./http/app";
import { credentialsFromEnv } from "./http/ingest-auth";
import { openDatabase } from "./storage/database";
import { migrateEmptyDatabase } from "./storage/migrate";
import { langfuseConfigFromEnv } from "./langfuse/config";

export async function startObservation(env: NodeJS.ProcessEnv = process.env): Promise<{ readonly port: number; stop(): Promise<void> }> {
  if (!env.OBSERVATION_DATABASE_URL) throw new Error("OBSERVATION_DATABASE_URL is required");
  const credentials = credentialsFromEnv(env);
  const langfuse = langfuseConfigFromEnv(env);
  if (!langfuse.ok) throw new Error(langfuse.error.detail);
  const db = openDatabase(env.OBSERVATION_DATABASE_URL);
  try {
    await migrateEmptyDatabase(db);
    const app = createApp({ db, credentials, langfuse: langfuse.value });
    const server = Bun.serve({ fetch: app.fetch, hostname: env.OBSERVATION_HOST ?? "127.0.0.1", port: Number(env.OBSERVATION_PORT ?? 8791) });
    return { port: server.port ?? Number(env.OBSERVATION_PORT ?? 8791), stop: async () => { server.stop(); await db.destroy(); } };
  } catch (error) { await db.destroy(); throw error; }
}

if (import.meta.main) await startObservation();
