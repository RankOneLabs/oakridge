import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { prepareAgentWorkdir } from "./runtime/agent-workdir";
import { createProductionComposition } from "./runtime/compose";
import { BunGitCommandRunner } from "./runtime/git-command-runner";
import { openDatabase } from "./storage/database";
import { migrateEmptyDatabase } from "./storage/migrate";

const optional = (name: string): string | null => process.env[name]?.trim() || null;
const database_url = process.env.DBOS_SYSTEM_DATABASE_URL;
if (!database_url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
const host = process.env.OAKRIDGE_DBOS_HOST ?? "127.0.0.1";
const port = Number(process.env.PORT ?? 8790);
// Agents publish to this backend directly (the kbbl proxy does not forward
// their secret), so their preamble names it as they reach it.
const publish_base_url = optional("OAKRIDGE_PUBLIC_URL") ?? `http://${host}:${port}`;
// A `workspace: none` session still needs a repository to run in; an empty one keeps it out of any checkout.
const workdir = await prepareAgentWorkdir(resolve(optional("OAKRIDGE_AGENT_WORKDIR") ?? `${tmpdir()}/oakridge-agent-workdir`), new BunGitCommandRunner());
if (!workdir.ok) throw new Error(`agent workdir: ${workdir.error.detail}`);
const agent_workdir = workdir.value;
const kbbl_base_url = optional("KBBL_BASE_URL");
if (!kbbl_base_url) console.warn("KBBL_BASE_URL is unset: agent workers cannot run, and each agent attempt fails with kbbl_unconfigured");
const github_token = optional("OAKRIDGE_GITHUB_TOKEN");
if (!github_token) console.warn("OAKRIDGE_GITHUB_TOKEN is unset: pull_request.observe fails with discovery_unsupported");
// The DBOS application version is the engine digest unless DBOS_APPLICATION_VERSION
// pins it; see workflows/engine-version.ts for what moves it and what does not.
// One startup sequence: validate the locked baseline, then launch DBOS, then bind HTTP.
const migration_db = openDatabase(database_url);
try { await migrateEmptyDatabase(migration_db); }
finally { await migration_db.destroy(); }
const composition = await createProductionComposition({ database_url, host, control_token: process.env.OAKRIDGE_CONTROL_TOKEN,
  executor: { kbbl_base_url, publication_key: optional("OAKRIDGE_PUBLICATION_KEY"), publish_base_url, agent_workdir, github_token } });
let server: ReturnType<typeof Bun.serve>;
try { server = Bun.serve({ hostname: host, port, fetch: composition.app.fetch }); }
catch (cause) { await composition.close(); throw cause; }
console.log(`oakridge-dbos ${composition.application_version} listening at ${server.url}`);
async function stop(): Promise<void> { server.stop(); await composition.close(); }
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
