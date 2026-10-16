/** Capture one named, already-launched v2 run for the frozen v1 adapter tests.
 * Usage: bun oakridge-dbos/scripts/capture-pwa-adapter-fixtures.ts <run-id> [v2-adapter-sample|v2-cohort-merge|v2-integration-merge|v2-planning-revise|v2-definition-detail]
 * Optional: OAKRIDGE_CAPTURE_URL and OAKRIDGE_CORE_CONTROL_TOKEN.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperatorArtifactDetail, OperatorDefinitionDetail, OperatorInboxPage, OperatorRunEvent, OperatorRunView, OperatorUnitView } from "../../kbbl/core/pwa/oakridge/operator-contracts";

const runId = process.argv[2];
if (!runId || !/^run-[0-9a-f]{16}$/.test(runId)) throw new Error("pass a named v2 run id (run-<16 hex characters>)");
const fixtureName = process.argv[3] ?? "v2-adapter-sample";
if (!["v2-adapter-sample", "v2-cohort-merge", "v2-integration-merge", "v2-planning-revise", "v2-definition-detail"].includes(fixtureName)) throw new Error("unsupported fixture name");
const base = (process.env.OAKRIDGE_CAPTURE_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const token = process.env.OAKRIDGE_CORE_CONTROL_TOKEN;
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json() as T;
};
async function captureEvent(): Promise<OperatorRunEvent> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 10_000);
  const cursor = Buffer.from(JSON.stringify({ commit_txid: "0", id: "0" })).toString("base64url");
  try {
    const response = await fetch(`${base}/events`, { headers: { "last-event-id": cursor, ...(token ? { authorization: `Bearer ${token}` } : {}) }, signal: controller.signal });
    if (!response.ok || !response.body) throw new Error(`/events: HTTP ${response.status}`);
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let eventType = "";
    while (true) {
      const next = await reader.read();
      if (next.done) break;
      buffer += decoder.decode(next.value, { stream: true });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trimEnd();
        if (line.startsWith("event:")) eventType = line.slice(6).trim();
        if (line.startsWith("data:") && eventType === "run_event") {
          const frame = JSON.parse(line.slice(5)) as OperatorRunEvent;
          if (frame.run_id === runId && frame.kind === "revision_published") return frame;
        }
      }
    }
    throw new Error(`no revision_published event for ${runId}`);
  } finally {
    clearTimeout(timeout);
    controller.abort();
  }
}
const path = `/api/runs/${encodeURIComponent(runId)}`;
const [run, units, inbox] = await Promise.all([
  get<OperatorRunView>(path), get<OperatorUnitView[]>(`${path}/units`), get<OperatorInboxPage>(`${path}/inbox`),
]);
if (run.run_id !== runId || units.some((unit) => unit.run_id !== runId)) throw new Error("response run id mismatch");
const output = resolve(import.meta.dir, `../../kbbl/core/pwa/oakridge/__fixtures__/${fixtureName}.json`);
if (fixtureName === "v2-definition-detail") {
  const definitionPath = `/api/definitions/${encodeURIComponent(run.definition_bundle_id)}`;
  const definition = await get<OperatorDefinitionDetail>(definitionPath);
  if (definition.digest !== run.definition_digest) throw new Error(`run ${runId} definition digest mismatch`);
  const workflow = { workflow: definition.workflow.workflow,
    stages: Object.fromEntries(Object.entries(definition.workflow.stages).map(([stage, value]) => [stage, {
      workers: Object.fromEntries(Object.entries(value.workers).map(([worker, declaration]) =>
        [worker, { kind: declaration.kind ?? null }])),
    }])) };
  writeFileSync(output, `${JSON.stringify({ source: definitionPath, captured_at: new Date().toISOString(), run_id: runId,
    definition: { bundle_id: definition.bundle_id, digest: definition.digest, workflow } }, null, 2)}\n`);
  console.log(`Captured ${runId}: definition ${definition.bundle_id}`);
  process.exit(0);
}
if (fixtureName === "v2-planning-revise") {
  const planning = units.find((unit) => unit.stage === "planning" && unit.attempts.some((attempt) => attempt.mode === "revise"));
  if (!planning) throw new Error(`run ${runId} has no planning revision attempt`);
  writeFileSync(output, `${JSON.stringify({ source: `${path}/units`, captured_at: new Date().toISOString(),
    run_id: runId, unit_id: planning.unit_id, attempts: planning.attempts }, null, 2)}\n`);
  console.log(`Captured ${runId}: ${planning.attempts.length} planning attempts`);
  process.exit(0);
}
const artifacts: OperatorArtifactDetail[] = [];
for (const unit of units) for (const artifact of unit.artifacts) {
  artifacts.push(await get<OperatorArtifactDetail>(`${path}/units/${encodeURIComponent(unit.unit_id)}/artifacts/${encodeURIComponent(artifact.artifact_key)}`));
}
const artifact = artifacts.find((candidate) => candidate.schema === "build_body");
if (!artifact) throw new Error(`run ${runId} has no build result; capture at an assessment review`);
const event = await captureEvent();
writeFileSync(output, `${JSON.stringify({ source: path, captured_at: new Date().toISOString(), run, units, inbox: { run_id: runId, items: inbox.items }, artifact, artifacts, event }, null, 2)}\n`);
console.log(`Captured ${runId}: ${units.length} units, ${inbox.items.length} inbox items, ${artifacts.length} artifacts`);
