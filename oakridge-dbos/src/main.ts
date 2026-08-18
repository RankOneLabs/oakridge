/**
 * The Oakridge backend process.
 *
 * Environment, listener, timers, signals. What the backend *is* — repositories,
 * workflow services, HTTP surface — is assembled by `createOakridgeRuntime`, so
 * the end-to-end tests can run the same composition this process runs.
 */
import { resolve } from "node:path";

import { DBOS } from "@dbos-inc/dbos-sdk";

import { KbblExecutorAdapter } from "./adapters/kbbl";
import { selectControlPlaneAccess } from "./http/control-auth";
import { createOakridgeRuntime } from "./runtime/compose";
import { GitRepositoryPreconditionChecker } from "./runtime/git-repository-preconditions";
import { DEFAULT_STALL_THRESHOLD_SECONDS } from "./storage/postgres-operators";

const required = (name: string): string => {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required`);
  return value;
};

const databaseUrl = required("DBOS_SYSTEM_DATABASE_URL");
const applicationVersion = required("DBOS_APPLICATION_VERSION");
const kbblBaseUrl = required("KBBL_BASE_URL");
const host = process.env.OAKRIDGE_DBOS_HOST?.trim() || "127.0.0.1";
const port = Number(process.env.PORT ?? "3001");
if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("PORT must be a valid TCP port");
const controlAccess = selectControlPlaneAccess({
  host,
  token: process.env.OAKRIDGE_CONTROL_TOKEN,
  allow_insecure_non_loopback: process.env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL === "1",
});
if (controlAccess.kind === "refused") throw new Error(controlAccess.detail);
const stallThresholdSeconds = Number(process.env.OAKRIDGE_STALL_THRESHOLD_SECONDS ?? String(DEFAULT_STALL_THRESHOLD_SECONDS));
if (!Number.isFinite(stallThresholdSeconds) || stallThresholdSeconds <= 0) throw new Error("OAKRIDGE_STALL_THRESHOLD_SECONDS must be a positive number of seconds");

DBOS.setConfig({ name: "oakridge", systemDatabaseUrl: databaseUrl, applicationVersion });

const runtime = await createOakridgeRuntime({
  database_url: databaseUrl,
  application_version: applicationVersion,
  executor_adapter: new KbblExecutorAdapter({ base_url: kbblBaseUrl, executor_function_identity: applicationVersion }),
  prompt_template_directory: resolve(import.meta.dir, "../../oakridge-core/prompts"),
  stall_threshold_seconds: stallThresholdSeconds,
  repository_preconditions: new GitRepositoryPreconditionChecker(),
  ...(controlAccess.kind === "token_required" ? { control_token: controlAccess.token } : {}),
});

await runtime.seed_builtins();
await DBOS.launch();

await runtime.dispatch_notifications();
await runtime.dispatch_launches();
let notificationDispatch: Promise<unknown> | null = null;
const notificationTimer = setInterval(() => {
  if (notificationDispatch) return;
  notificationDispatch = runtime.dispatch_notifications()
    .catch((error: unknown) => { console.error("artifact notification dispatch failed", error); })
    .finally(() => { notificationDispatch = null; });
}, 1_000);
let launchDispatch: Promise<unknown> | null = null;
const launchTimer = setInterval(() => {
  if (launchDispatch) return;
  launchDispatch = runtime.dispatch_launches()
    .catch((error: unknown) => { console.error("run launch dispatch failed", error); })
    .finally(() => { launchDispatch = null; });
}, 1_000);

// The outbox is polled every second by both dispatchers, so delivered rows left
// in place turn a bounded working set into a table that only ever grows. Swept
// on its own slow timer: the retention window keeps a day of dispatch history,
// which is what an operator would want to look back at, and no more.
const OUTBOX_RETENTION_MS = 24 * 60 * 60 * 1_000;
const OUTBOX_PURGE_INTERVAL_MS = 60 * 60 * 1_000;
let outboxPurge: Promise<unknown> | null = null;
const outboxPurgeTimer = setInterval(() => {
  if (outboxPurge) return;
  outboxPurge = runtime.purge_outbox(new Date(Date.now() - OUTBOX_RETENTION_MS).toISOString())
    .catch((error: unknown) => { console.error("command outbox purge failed", error); })
    .finally(() => { outboxPurge = null; });
}, OUTBOX_PURGE_INTERVAL_MS);

const server = Bun.serve({
  hostname: host,
  port,
  idleTimeout: 255,
  fetch(request, bunServer) {
    if (new URL(request.url).pathname === "/events") {
      bunServer.timeout(request, 0);
    }
    return runtime.app.fetch(request);
  },
});
console.log(`Oakridge DBOS backend listening on ${server.url}`);

let shutdownPromise: Promise<void> | null = null;
const shutdown = (): Promise<void> => {
  if (shutdownPromise) return shutdownPromise;
  shutdownPromise = (async () => {
    clearInterval(notificationTimer);
    clearInterval(launchTimer);
    clearInterval(outboxPurgeTimer);
    server.stop();
    // clearInterval stops the next purge from starting; it does not settle one
    // already running, which would still be holding a connection when SQL closes.
    await Promise.allSettled(outboxPurge ? [outboxPurge] : []);
    await DBOS.shutdown();
    await runtime.close();
  })();
  return shutdownPromise;
};
process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);
