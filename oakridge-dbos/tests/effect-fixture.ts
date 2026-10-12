import { Pool } from "pg";
import { migrateEmptyDatabase } from "../src/storage/migrate";

process.env.OAKRIDGE_EFFECT_ENCRYPTION_KEY ??= Buffer.alloc(32, 17).toString("base64url");
import { PgPostgresExecutor } from "../src/storage/sql-executor";
import { createProductionComposition } from "../src/runtime/compose";
import type { Workflow } from "../src/core-client/core-types";
import type { RunId } from "../src/storage/schema-records";
import type { ProviderCapabilities } from "../src/storage/mutation-service";
import { PROVIDER_KINDS } from "../src/effects/provider-catalog";

/** The fixture workflows declare a test-only stub, with no external provider IO. */
export const stubProviderCapabilities: ProviderCapabilities = {
  probe: async (kind) => kind === PROVIDER_KINDS.stub
    ? { ok: true, value: true }
    : { ok: false, error: { operation: "probe_test_provider", entity_id: kind, detail: "fixture provider unavailable" } },
  check_github: async () => ({ ok: false, error: { operation: "probe_test_provider", entity_id: PROVIDER_KINDS.pull_request, detail: "fixture has no GitHub provider" } }),
};

/** v2 bodies are plain runtime values; the schema lives on the stage's artifact. */
export const unit: Record<string, never> = {};

interface TestDatabase { readonly url: string; readonly db: PgPostgresExecutor }
export async function withDatabase(operation: (database: TestDatabase) => Promise<void>): Promise<void> {
  const admin_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!admin_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for production effect integration tests");
  const name = `effects_${crypto.randomUUID().replaceAll("-", "")}`;
  const admin = new Pool({ connectionString: admin_url });
  const url = new URL(admin_url); url.pathname = `/${name}`;
  await admin.query(`CREATE DATABASE ${name}`);
  const db = PgPostgresExecutor.connect(url.href);
  try { await migrateEmptyDatabase(db); await operation({ url: url.href, db }); }
  finally {
    try {
      await db.close();
      // A forced drop can terminate a still-closing pg client and surface as an unhandled 57P01.
      await admin.query(`DROP DATABASE ${name}`);
    } finally { await admin.end(); }
  }
}

export async function waitUntil(predicate: () => Promise<boolean>): Promise<void> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (await predicate()) return;
    await Bun.sleep(10);
  }
  throw new Error("timed out awaiting durable effect evidence");
}

/**
 * A one-stage workflow whose single code worker runs the operation under test.
 * The v1 fixtures it replaced were assembled from a shipped bundle that the v2
 * cutover removed, so the shape is stated here instead of loaded.
 */
export function operationWorkflow(operation: "repository.prepare" | "pull_request.observe"): Workflow {
  return {
    workflow: `${operation.replace(".", "_")}_fixture`,
    input: "unit",
    schemas: { unit: "unit" },
    run: { units: { root: { stage: "work" } }, outcome: {} },
    stages: {
      work: {
        input: "unit",
        artifacts: {},
        workers: { operator: { kind: "code", operation, inputs: {}, creates: [] } },
        outcome: {},
      },
    },
  };
}

/** A one-stage workflow whose single agent worker drives a kbbl session. */
export function sessionWorkflow(): Workflow {
  return {
    workflow: "session_fixture",
    input: "unit",
    schemas: { unit: "unit" },
    run: { units: { root: { stage: "work" } }, outcome: {} },
    stages: {
      work: {
        input: "unit",
        artifacts: {},
        workers: {
          author: { kind: "agent", prompts: { initial: "workflow-config/prompts/templates/implementation_assessment.md" },
            inputs: {}, creates: [], session: "fresh", runtime: { harness: "claude-code", model: "sonnet" } },
        },
        outcome: {},
      },
    },
  };
}

interface Started { readonly run_id: RunId; readonly bundle_id: string }
/** Launching is the `launched` event; v1's separate begin trigger is gone. */
export async function begin(composition: Awaited<ReturnType<typeof createProductionComposition>>, workflow: Workflow, input: unknown): Promise<Started> {
  const created = await composition.app.request("http://localhost/runs", {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ workflow, input }) });
  if (created.status !== 201) throw new Error(await created.text());
  return await created.json() as Started;
}
