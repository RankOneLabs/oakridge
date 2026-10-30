/** Send one captured Oakridge run's gradeable items to Langfuse for its native evaluators.
 * Usage: bun scripts/langfuse-project-run.ts <run_id> [--dry-run] */
import { LANGFUSE_PILOT_QUESTIONS } from "../src/grading/catalogue/langfuse-pilot";
import { LangfuseBackend } from "../src/langfuse/backend";
import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { nativeIdentity, nativeJevEvaluator } from "../src/langfuse/native-evaluator";
import { RESTRICTED_POLICY } from "../src/langfuse/projection";
import { runPackages, type PilotPackage } from "../src/langfuse/run-packages";
import { openDatabase, type Database, type TenantScope } from "../src/storage/database";
import { registerGradingContext, startDelegatedExecution } from "../src/storage/grading-store";
import { loadProjectionInput } from "../src/storage/projection-input";
import { loadRunCapture } from "../src/storage/run-capture-store";

const PROJECTION_VERSION = "v1";

type PackageOutcome =
  | { readonly status: "written"; readonly trace_id: string }
  | { readonly status: "pending" | "failed"; readonly detail: string };

async function project(db: Database, tenant: TenantScope, backend: LangfuseBackend, model: string,
  pilot: PilotPackage): Promise<PackageOutcome> {
  const entry = LANGFUSE_PILOT_QUESTIONS[pilot.question_id];
  const evaluator = nativeJevEvaluator(pilot.question_id, entry.definition.question_version, entry.text, model);
  if (!evaluator.ok) return { status: "failed", detail: evaluator.error.detail };
  const registered = await registerGradingContext(db, tenant, { question: entry.definition, evidence: pilot.evidence,
    evaluator: evaluator.value });
  if (!registered.ok) return { status: "failed", detail: registered.error.detail };
  const execution = await startDelegatedExecution(db, tenant,
    nativeIdentity(pilot, evaluator.value, entry.definition.question_version));
  if (!execution.ok) return { status: "failed", detail: execution.error.detail };
  const input = await loadProjectionInput(db, tenant, { execution_id: execution.value.execution_id,
    question_text: entry.text, projection_version: PROJECTION_VERSION, policy: RESTRICTED_POLICY });
  if (!input) return { status: "failed", detail: "projection inputs were not found" };
  const projected = await backend.project(input);
  if (!projected.ok) return { status: "pending", detail: projected.error.detail };
  return projected.value.status === "written" ? { status: "written", trace_id: projected.value.trace_id }
    : { status: "written", trace_id: projected.value.external_ids.trace_id };
}

if (import.meta.main) {
  const args = Bun.argv.slice(2);
  const run_id = args.find((arg) => !arg.startsWith("--"));
  const is_dry_run = args.includes("--dry-run");
  if (!run_id) throw new Error("usage: bun scripts/langfuse-project-run.ts <run_id> [--dry-run]");
  const database_url = process.env.OBSERVATION_DATABASE_URL;
  if (!database_url) throw new Error("OBSERVATION_DATABASE_URL is required");
  const tenant: TenantScope = { producer: "oakridge", namespace: process.env.OAKRIDGE_OBSERVATION_NAMESPACE ?? "default" };
  const db = openDatabase(database_url);
  try {
    const capture = await loadRunCapture(db, tenant, run_id);
    if (!capture.ok) throw new Error(capture.error.detail);
    const packages = runPackages(capture.value);
    if (!packages.ok) throw new Error(packages.error.detail);
    for (const exclusion of packages.value.exclusions)
      console.log(`excluded ${exclusion.question_id} ${exclusion.occurrence_id}: ${exclusion.reason.kind}`);
    if (is_dry_run) {
      for (const pilot of packages.value.packages)
        console.log(`would project ${pilot.question_id} ${pilot.subject.occurrence_id}: ${pilot.evidence.references.map((ref) => ref.ref).join(", ")}${pilot.evidence.is_incomplete ? " (incomplete)" : ""}`);
    } else {
      const configuration = langfuseConfigFromEnv(process.env);
      if (!configuration.ok) throw new Error(configuration.error.detail);
      if (configuration.value.status === "disabled") throw new Error("Langfuse is disabled; set OBSERVATION_LANGFUSE_* in observation/.env");
      const config = configuration.value.config;
      if (!config.decision_model) throw new Error("OBSERVATION_LANGFUSE_DECISION_MODEL is required");
      const backend = new LangfuseBackend(db, tenant, config, createLangfuseHttpClient(config));
      for (const pilot of packages.value.packages) {
        const outcome = await project(db, tenant, backend, config.decision_model, pilot);
        console.log(`${outcome.status} ${pilot.question_id} ${pilot.subject.occurrence_id}: ${outcome.status === "written" ? `trace ${outcome.trace_id}` : outcome.detail}`);
        if (outcome.status !== "written") process.exitCode = 1;
      }
    }
    console.log(`${packages.value.packages.length} packages, ${packages.value.exclusions.length} excluded`);
  } finally { await db.destroy(); }
}
