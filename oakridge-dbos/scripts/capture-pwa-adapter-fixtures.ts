/** Capture one named, already-launched v2 run for the frozen v1 adapter tests.
 * Usage: bun oakridge-dbos/scripts/capture-pwa-adapter-fixtures.ts <run-id>
 * Optional: OAKRIDGE_CAPTURE_URL and OAKRIDGE_CORE_CONTROL_TOKEN.
 */
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import type { OperatorArtifactDetail, OperatorInboxPage, OperatorRunView, OperatorUnitView } from "../../kbbl/core/pwa/oakridge/operator-contracts";

const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("pass a named v2 run UUID");
const base = (process.env.OAKRIDGE_CAPTURE_URL ?? "http://127.0.0.1:8790").replace(/\/$/, "");
const token = process.env.OAKRIDGE_CORE_CONTROL_TOKEN;
const get = async <T>(path: string): Promise<T> => {
  const response = await fetch(`${base}${path}`, { headers: token ? { authorization: `Bearer ${token}` } : {} });
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return await response.json() as T;
};
const path = `/api/runs/${encodeURIComponent(runId)}`;
const [run, units, inbox] = await Promise.all([
  get<OperatorRunView>(path), get<OperatorUnitView[]>(`${path}/units`), get<OperatorInboxPage>(`${path}/inbox`),
]);
if (run.run_id !== runId || units.some((unit) => unit.run_id !== runId)) throw new Error("response run id mismatch");
const artifacts: OperatorArtifactDetail[] = [];
for (const unit of units) for (const artifact of unit.artifacts) {
  artifacts.push(await get<OperatorArtifactDetail>(`${path}/units/${encodeURIComponent(unit.unit_id)}/artifacts/${encodeURIComponent(artifact.artifact_key)}`));
}
const output = resolve(import.meta.dir, "../../kbbl/core/pwa/oakridge/__fixtures__/v2-run.json");
writeFileSync(output, `${JSON.stringify({ source: path, captured_at: new Date().toISOString(), run, units, inbox, artifacts }, null, 2)}\n`);
console.log(`Captured ${runId}: ${units.length} units, ${inbox.items.length} inbox items, ${artifacts.length} artifacts`);
