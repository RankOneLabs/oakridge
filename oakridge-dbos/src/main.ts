import { createProductionComposition } from "./runtime/compose";

const database_url = process.env.DBOS_SYSTEM_DATABASE_URL;
const core_binary = process.env.OAKRIDGE_CORE_BINARY;
if (!database_url) throw new Error("DBOS_SYSTEM_DATABASE_URL is required");
if (!core_binary) throw new Error("OAKRIDGE_CORE_BINARY is required; run scripts/oakridge-start to build workflow-cli");
const host = process.env.OAKRIDGE_DBOS_HOST ?? "127.0.0.1";
// The DBOS application version is the engine digest unless DBOS_APPLICATION_VERSION
// pins it; see workflows/engine-version.ts for what moves it and what does not.
const composition = await createProductionComposition({ database_url, core_binary, host, control_token: process.env.OAKRIDGE_CONTROL_TOKEN });
const server = Bun.serve({ hostname: host, port: Number(process.env.PORT ?? 8790), fetch: composition.app.fetch });
console.log(`oakridge-dbos ${composition.application_version} listening at ${server.url}`);
async function stop(): Promise<void> { server.stop(); await composition.close(); }
process.once("SIGINT", () => { void stop(); });
process.once("SIGTERM", () => { void stop(); });
