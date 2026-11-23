import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createScratchDatabase } from "../../../oakridge-dbos/scripts/scratch-database";
import { createProductionComposition, type ProductionOptions } from "../../../oakridge-dbos/src/runtime/compose";
import { openDatabase } from "../../../oakridge-dbos/src/storage/database";
import { migrateEmptyDatabase } from "../../../oakridge-dbos/src/storage/migrate";
import { startObservation, type StartupOptions } from "../../../observation/src/main";

const directory = resolve(import.meta.dir, "../..");

export interface StackUrls {
  readonly core: string;
  readonly observation: string;
  readonly kbbl: string;
  readonly observationDatabase: string;
}

interface StackOptions {
  readonly agents?: { readonly url: string };
  readonly runners?: StartupOptions["runners"];
  readonly operations?: ProductionOptions["operation_runner"];
}

export async function withScratchStack(options: StackOptions, verify: (urls: StackUrls) => Promise<void>): Promise<void> {
  const databaseUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!databaseUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const temporary = await mkdtemp(join(tmpdir(), "oakridge-portability-"));
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const cleanup: (() => void | Promise<void>)[] = [() => rm(temporary, { recursive: true, force: true })];
  try {
    const authority = await createScratchDatabase(databaseUrl, `portability_core_${suffix}`);
    cleanup.push(authority.drop);
    const observation = await createScratchDatabase(databaseUrl, `portability_obs_${suffix}`);
    cleanup.push(observation.drop);
    if (options.agents) {
      const source = resolve(directory, "../workflow-config/definitions");
      const definitions = join(temporary, "definitions");
      await cp(source, definitions, { recursive: true });
      const path = join(definitions, "launchable.json");
      const fixture = JSON.parse(await readFile(path, "utf8"));
      fixture.portability.audience = "user";
      await writeFile(path, JSON.stringify(fixture));
      const original = process.env.OAKRIDGE_DEFINITION_ROOT;
      process.env.OAKRIDGE_DEFINITION_ROOT = definitions;
      cleanup.push(() => {
        if (original === undefined) delete process.env.OAKRIDGE_DEFINITION_ROOT;
        else process.env.OAKRIDGE_DEFINITION_ROOT = original;
      });
    }
    const db = openDatabase(authority.url);
    try { await migrateEmptyDatabase(db); } finally { await db.destroy(); }

    let authorityFetch: (request: Request) => Response | Promise<Response> = () => new Response("Starting", { status: 503 });
    const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => authorityFetch(request) });
    cleanup.push(() => { server.stop(true); });
    const coreUrl = `http://127.0.0.1:${server.port}`;

    const observed = await startObservation({
      OBSERVATION_DATABASE_URL: observation.url,
      OBSERVATION_GRADING_CONFIG_DIR: join(temporary, "grading"),
      OBSERVATION_HOST: "127.0.0.1",
      OBSERVATION_PORT: "0",
      OAKRIDGE_CORE_BASE_URL: coreUrl,
      TYPESAFE_API_KEY: "local-test-runner",
      OBSERVATION_INGEST_CREDENTIALS: JSON.stringify([{ token: "fixture-ingest", producer: "oakridge", namespace: "portability" }]),
      OBSERVATION_READ_CREDENTIALS: JSON.stringify([{ token: "fixture-read", producer: "oakridge", namespace: "portability" }]),
      OBSERVATION_CONFIGURE_CREDENTIALS: JSON.stringify([{ token: "fixture-configure" }]),
    }, { runners: options.runners, reconcile_ms: 50, worker_idle_ms: 50 });
    cleanup.push(observed.stop);
    const observationUrl = `http://127.0.0.1:${observed.port}`;

    const portProbe = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response() });
    const port = portProbe.port;
    portProbe.stop(true);
    if (!port) throw new Error("Could not allocate a kbbl test port");
    const kbblUrl = `http://127.0.0.1:${port}`;
    const originalOrigins = process.env.OAKRIDGE_ALLOWED_ORIGINS;
    process.env.OAKRIDGE_ALLOWED_ORIGINS = kbblUrl;
    cleanup.push(() => {
      if (originalOrigins === undefined) delete process.env.OAKRIDGE_ALLOWED_ORIGINS;
      else process.env.OAKRIDGE_ALLOWED_ORIGINS = originalOrigins;
    });
    const core = await createProductionComposition({
      database_url: authority.url, host: "127.0.0.1",
      pr_integration_default: options.agents ? "gated-review" : "none",
      operation_runner: options.operations,
      observation: { url: observationUrl, namespace: "portability", token: "fixture-ingest", poll_ms: 50 },
      executor: options.agents ? {
        kbbl_base_url: options.agents.url, publication_key: "fixture-publication-key", publish_base_url: coreUrl,
        agent_workdir: temporary, gated_review_url: coreUrl,
      } : undefined,
      timing: { retry_initial_seconds: 0.1, observe_interval_seconds: 0.05, wake_timeout_seconds: 0.5 },
    });
    cleanup.push(() => core.close());
    authorityFetch = core.app.fetch;

    await mkdir(join(temporary, "kbbl"));
    const kbbl = Bun.spawn({
      cmd: [process.execPath, "core/server.ts", "--port", String(port), "--dataDir", join(temporary, "kbbl"), "--config", join(temporary, "kbbl.json")],
      cwd: directory,
      env: { PATH: process.env.PATH, OAKRIDGE_CORE_BASE_URL: coreUrl, OAKRIDGE_OBSERVATION_URL: observationUrl,
        OAKRIDGE_ALLOWED_ORIGINS: kbblUrl, OAKRIDGE_OBSERVATION_NAMESPACE: "portability", OAKRIDGE_OBSERVATION_READ_TOKEN: "fixture-read" },
      stderr: "inherit", stdout: "inherit",
    });
    cleanup.push(async () => { kbbl.kill(); await kbbl.exited; });
    await Promise.all([coreUrl, observationUrl, kbblUrl].map(waitForHealth));
    await verify({ core: coreUrl, observation: observationUrl, kbbl: kbblUrl, observationDatabase: observation.url });
  } finally {
    const errors: unknown[] = [];
    for (const close of cleanup.reverse()) {
      try { await close(); } catch (error) { errors.push(error); }
    }
    if (errors.length) throw new AggregateError(errors, "Scratch stack cleanup failed");
  }
}

export async function waitForHealth(url: string): Promise<unknown> {
  const deadline = Date.now() + 10_000;
  while (Date.now() < deadline) {
    const response = await fetch(new URL("/health", url), { signal: AbortSignal.timeout(2000) }).catch(() => null);
    if (response?.ok) return response.json();
    await Bun.sleep(100);
  }
  throw new Error(`No healthy response from ${url}`);
}
