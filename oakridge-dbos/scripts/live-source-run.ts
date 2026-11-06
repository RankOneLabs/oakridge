/** Launch the committed development workflow and retain its real publisher deliveries.
 *
 * bun oakridge-dbos/scripts/live-source-run.ts --input input.json \
 *   --output observation/verification --through brief
 *
 * Requires OAKRIDGE_TEST_DATABASE_URL, a reachable gated-review MCP, and the
 * installed Codex ACP agent's normal authentication. Uses fresh, retained
 * databases and an isolated ACP ledger. No fixture bodies, provider stubs,
 * real database reset, deployment, branch creation or integration approval.
 * Planning reviews in this throwaway run are automatically accepted. With
 * --through assessment, brief approval authorizes the input's actual build;
 * the assessment is captured without approving it or merging its PR.
 */
import { mkdir, rename } from "node:fs/promises";
import { join, resolve } from "node:path";
import { z } from "zod";
import { resolveLaunchableDefinition } from "../../workflow-config/src/definition-store";
import { createScratchDatabase } from "./scratch-database";
import { openLiveSourceAgent } from "./live-source-agent";
import { LiveSourceGit } from "./live-source-git";
import { createProductionComposition } from "../src/runtime/compose";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { openDatabase as openObservation } from "../../observation/src/storage/database";
import { migrateEmptyDatabase as migrateObservation } from "../../observation/src/storage/migrate";
import { createApp } from "../../observation/src/http/app";
import { oakridgeProfile } from "../../observation/src/producers/oakridge/profile";
import { decodeSourceEventDelivery, type SourceEventDelivery } from "../../observation/src/ingest/cursor";
import { publishObservationOnce, type ObservationOptions } from "../src/adapters/observation";
import { createOperationRunner } from "../src/operations/runner";
import { GatedReviewPullRequestReader } from "../src/runtime/gated-review-pull-requests";
import { createAgentProvider } from "../src/effects/agent-provider";
import { KbblClient } from "../src/adapters/kbbl";
import type { RunInspectView } from "../src/projections/run-view";
import { defaultModelForRuntime } from "../../kbbl/core/runtime";

// Mirrors the committed development.yaml input and existing launch settings.
const inputSchema = z.object({ title: z.string(), spec: z.string(), primary_repository_key: z.string(),
  final_merge_policy: z.enum(["require_merge", "allow_close_without_merge"]), repositories: z.array(z.object({
    key: z.string(), preparation: z.object({ repository_path: z.string(), expected_head: z.string().nullable() }),
    forge: z.object({ owner: z.string(), name: z.string(), build_base: z.string(), final_base: z.string() }),
  })).min(1) });
export interface SourceRunOptions { readonly input: z.infer<typeof inputSchema>; readonly output: string;
  readonly through: "plan" | "brief" | "assessment"; readonly timeout_ms?: number }
export interface SourceRunReport { readonly run_id: string; readonly definition_id: string;
  readonly capture_path: string; readonly authority_database: string; readonly observation_database: string }

async function writeJson(path: string, value: unknown): Promise<void> {
  await Bun.write(`${path}.pending`, JSON.stringify(value, null, 2) + "\n");
  await rename(`${path}.pending`, path);
}

export async function captureSourceRun(options: SourceRunOptions): Promise<SourceRunReport> {
  const server_url = process.env.OAKRIDGE_TEST_DATABASE_URL;
  if (!server_url) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required");
  const gated_review_url = process.env.OAKRIDGE_GATED_REVIEW_URL;
  if (!gated_review_url) throw new Error("OAKRIDGE_GATED_REVIEW_URL is required");
  const output = resolve(options.output);
  if (output === "/tmp" || output.startsWith("/tmp/")) throw new Error("capture output must be durable, outside /tmp");
  const input = inputSchema.parse(options.input);
  const definition = resolveLaunchableDefinition("development");
  if (!definition.ok) throw new Error(JSON.stringify(definition.error));
  const suffix = crypto.randomUUID().replaceAll("-", "");
  const directory = join(output, suffix);
  await mkdir(directory, { recursive: true });
  const authority_database = `oakridge_source_live_${suffix}`;
  const observation_database = `observation_source_live_${suffix}`;
  const authority = await createScratchDatabase(server_url, authority_database);
  const observation = await createScratchDatabase(server_url, observation_database);
  // Deliberately never call drop(): both databases are completion evidence.
  const db = openDatabase(authority.url);
  const captured_db = openObservation(observation.url);
  const git = new LiveSourceGit(gated_review_url);
  const agent = await openLiveSourceAgent(join(directory, "agents"), git);
  let handler: (request: Request) => Response | Promise<Response> = () => new Response("starting", { status: 503 });
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: (request) => handler(request) });
  const base_url = `http://127.0.0.1:${server.port}`;
  const control_token = crypto.randomUUID();
  const tenant = { producer: "oakridge", namespace: `live-${suffix}` };
  const token = crypto.randomUUID();
  const deliveries: SourceEventDelivery[] = [];
  let composition: Awaited<ReturnType<typeof createProductionComposition>> | null = null;
  let report: SourceRunReport | null = null;
  try {
    await migrateEmptyDatabase(db);
    await migrateObservation(captured_db);
    const sink = createApp({ db: captured_db, credentials: { ingest: [{ ...tenant, token }], read: [] }, profile: oakridgeProfile });
    const capture_path = join(directory, "capture.json");
    const publisher: ObservationOptions = { url: "http://observation.live", namespace: tenant.namespace, token,
      fetcher: async (url, init) => {
        const request = new Request(url, init);
        if (request.method === "POST") {
          const delivery = decodeSourceEventDelivery(await request.clone().json());
          if (!delivery) throw new Error("production publisher emitted an invalid delivery");
          // Save the exact wire payload before acknowledging it. The actual sink
          // persists the cursor, validates and projects it; no acknowledgement stub.
          const previous = deliveries.at(-1);
          if (previous?.cursor.id !== delivery.cursor.id) {
            deliveries.push(delivery);
            await writeJson(capture_path, deliveries);
          }
        }
        return sink.request(request);
      } };
    const kbbl = new KbblClient({ base_url: "http://kbbl.live", fetch: async (url, init) => agent.app.request(new Request(url, init)) });
    const provider = createAgentProvider({ kbbl, publication_key: crypto.randomUUID(),
      publish_base_url: base_url, default_workdir: input.repositories[0]!.preparation.repository_path });
    composition = await createProductionComposition({ database_url: authority.url, host: "127.0.0.1", control_token,
      effect_provider: provider, operation_runner: createOperationRunner({ git,
        pull_requests: new GatedReviewPullRequestReader(gated_review_url) }) });
    handler = composition.app.fetch;
    const request = async (path: string, body?: unknown): Promise<Response> => {
      const response = await composition!.app.request(path, { method: body === undefined ? "GET" : "POST",
        headers: { authorization: `Bearer ${control_token}`, "content-type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body) });
      if (!response.ok) throw new Error(`${path} HTTP ${response.status}: ${await response.text()}`);
      return response;
    };
    const settings = { harness: "codex", model: defaultModelForRuntime("codex"), effort: null };
    const launched = await (await request("/api/runs", { request_id: crypto.randomUUID(),
      definition_id: definition.value.definition_id, input, config: { sessions: {
        analysis: { author: settings, spec_editor: settings }, planning: { planner: settings }, brief: { writer: settings },
        cohort: { builder: settings, assessor: settings },
      } } })).json() as { run_id: string };
    report = { run_id: launched.run_id, definition_id: definition.value.definition_id,
      capture_path, authority_database, observation_database };
    await writeJson(join(directory, "run.json"), report);
    console.log(JSON.stringify(report));
    const deadline = Date.now() + (options.timeout_ms ?? 1_800_000);
    let complete = false;
    while (Date.now() < deadline) {
      while (await publishObservationOnce(db, publisher)) { /* drain the committed ordered tail */ }
      const inspect = await (await request(`/api/runs/${launched.run_id}/inspect`)).json() as RunInspectView;
      await writeJson(join(directory, "inspect.json"), inspect);
      const artifacts = inspect.artifacts.filter((artifact) => artifact.latest_revision);
      console.log(JSON.stringify({ artifacts: artifacts.map((artifact) => artifact.artifact_key),
        attention: inspect.attention.map((item) => item.kind === "awaiting_review" ? item.review : item.kind) }));
      const target = options.through;
      complete = artifacts.some((artifact) => artifact.artifact_key === target);
      if (complete) break;
      const stalled = inspect.attention.find((item) => item.kind !== "awaiting_review");
      if (stalled) throw new Error(`source run needs intervention: ${JSON.stringify(stalled)}`);
      for (const review of inspect.attention) {
        if (review.kind !== "awaiting_review") continue;
        // Approve only the reviews necessary for the requested capture. Never
        // approve an assessment, closed-PR review or integration review.
        const allowed = ["analysis_review", "spec_review", "tasks_review", "plan_review",
          ...(target === "assessment" ? ["brief_review"] : [])];
        if (!allowed.includes(review.review)) continue;
        await request(`/api/runs/${launched.run_id}/units/${encodeURIComponent(review.unit_id)}/reviews/${review.review}/decide`, {
          request_id: crypto.randomUUID(), decision: "accept", target: review.target,
          payload: { feedback: "Accepted for the isolated live verification run." },
        });
      }
      await Bun.sleep(1000);
    }
    if (!complete) throw new Error("source run timed out; databases, capture and inspect.json retained");
    await request(`/api/runs/${launched.run_id}/cancel`, { request_id: crypto.randomUUID() });
    while (await publishObservationOnce(db, publisher)) { /* include cancellation */ }
    await writeJson(join(directory, "authority-rows.json"), await db.selectFrom("authority.event")
      .select(["id", "commit_txid", "created_at", "payload", "run_id", "unit_id"])
      .where("run_id", "=", launched.run_id).orderBy("commit_txid").orderBy("id").execute());
    await writeJson(join(directory, "complete.json"), report);
    return report;
  } finally {
    try { await composition?.close(); } finally {
      server.stop(true);
      try { await agent.close(); } finally { await db.destroy(); await captured_db.destroy(); }
    }
  }
}

if (import.meta.main) {
  if (!process.env.OAKRIDGE_TEST_DATABASE_URL) console.warn("SKIP: live source run; missing OAKRIDGE_TEST_DATABASE_URL");
  else {
    const args = Bun.argv.slice(2);
    const argument = (name: string) => { const index = args.indexOf(name); return index < 0 ? undefined : args[index + 1]; };
    const path = argument("--input");
    if (!path) throw new Error("--input must name a development workflow input JSON file");
    const through = argument("--through") ?? "brief";
    if (through !== "plan" && through !== "brief" && through !== "assessment") throw new Error("invalid --through");
    await captureSourceRun({ input: inputSchema.parse(await Bun.file(path).json()),
      output: argument("--output") ?? "observation/verification", through });
  }
}
