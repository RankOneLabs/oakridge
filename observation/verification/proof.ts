/**
 * The one verification program. Every proof runs through here, on the stack that
 * scripts/oakridge-shadow starts, and reuses its resolved state across scenarios
 * and restarts. See README.md for the invocations.
 *
 *   bun observation/verification/proof.ts runtime
 *   bun observation/verification/proof.ts live
 *   bun observation/verification/proof.ts source-run --input <file> [--through plan|brief|assessment]
 *   bun observation/verification/proof.ts registration --input <file>
 *   bun observation/verification/proof.ts grading --input <file>
 *   bun observation/verification/proof.ts relations --input <file> --shared-input <file>
 *   bun observation/verification/proof.ts workspace --input <file>
 *
 * Exits zero only when the requested scenario passed. The report is written
 * either way, so a failure keeps its diagnostics.
 */
import { mkdir, rename } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { NO_EVIDENCE, PENDING_SCENARIOS, redactReport, reportStatus, type LauncherState, type ProofReport,
  type ScenarioId, type ScenarioReport, type SourceIdentity } from "./proof-contract";
import { registrationScenario, type RegistrationSource } from "./registration";
import { err, ok } from "../src/domain/primitives";
import { gradingControls } from "../src/grading/budget";
import { registryRunners } from "../src/grading/worker";
import { openDatabase } from "../src/storage/database";
import { gradingScenario, providerSettings, type GradingSource } from "./grading";
import { relationsScenario, type RelationsSource } from "./relations";
import { workspaceScenario } from "./workspace";
import { liveScenario, runtimeScenario } from "./scenarios";
import { createDisposableRepository, createShadowIo, readLauncherState, readSourceIdentity, type ProofIo } from "./shadow-session";
import { sourceRunInputSchema, sourceRunScenario, type SourceRunInput, type SourceRunTarget } from "./source-run";

const REPORT_ROOT = resolve(import.meta.dir, "reports");

export interface ProofRun {
  readonly proof_id: string;
  readonly scenario_id: ScenarioId;
  readonly source: SourceIdentity;
  readonly launcher: LauncherState | null;
  readonly scenario: () => Promise<ScenarioReport>;
  /** Every secret value the report must not contain. */
  readonly secrets: () => Promise<readonly string[]>;
  readonly now: () => Date;
}

/** Runs one scenario to a report; a scenario that throws is a failed proof with its reason kept. */
export async function runProof(run: ProofRun): Promise<{ readonly report: ProofReport; readonly text: string }> {
  const started_at = run.now().toISOString();
  const scenario = await run.scenario().catch((cause: unknown): ScenarioReport => ({ id: run.scenario_id, status: "failed", evidence: NO_EVIDENCE,
    checks: [{ name: "the scenario completes", passed: false, detail: cause instanceof Error ? cause.message : String(cause) }] }));
  const report: ProofReport = { proof_id: run.proof_id, started_at, finished_at: run.now().toISOString(), source: run.source,
    launcher: run.launcher, status: reportStatus(scenario), scenario, pending: PENDING_SCENARIOS };
  const redacted = redactReport(JSON.stringify(report, null, 2) + "\n", await run.secrets());
  if (redacted.redacted === 0) return { report, text: redacted.text };
  const leaked: ProofReport = { ...report, status: "failed", scenario: { ...scenario, status: "failed",
    checks: [...scenario.checks, { name: "the report carries no secret", passed: false, detail: `${redacted.redacted} occurrence(s) redacted` }] } };
  return { report: leaked, text: redactReport(JSON.stringify(leaked, null, 2) + "\n", await run.secrets()).text };
}

async function secretValues(io: ProofIo): Promise<readonly string[]> {
  const tokens = await io.tokens();
  const password = Bun.file(join(io.state.state_dir, "observation-database.password"));
  const key = Bun.file(join(io.state.state_dir, "publication.key"));
  return [...(tokens.ok ? Object.values(tokens.value.capabilities) : []),
    ...(await password.exists() ? [(await password.text()).trim()] : []), ...(await key.exists() ? [(await key.text()).trim()] : [])];
}

async function writeReport(directory: string, text: string): Promise<string> {
  const path = join(directory, "report.json");
  await Bun.write(`${path}.pending`, text);
  await rename(`${path}.pending`, path);
  return path;
}

/**
 * The registration proof's real runs, on a disposable clone of the input's primary repository so
 * the proof can withhold it from observation. Its origin is the source's, so the run prepares and
 * builds exactly as the input describes.
 */
async function registrationSource(io: ProofIo, input: SourceRunInput, directory: string, proof_id: string): Promise<RegistrationSource> {
  const primary = input.repositories.find((repository) => repository.key === input.primary_repository_key);
  if (!primary) throw new Error(`the input names no ${input.primary_repository_key} repository`);
  const repository = await createDisposableRepository(primary.preparation.repository_path, join(tmpdir(), "oakridge-proof", proof_id));
  if (!repository.ok) throw new Error(`${repository.error.operation}: ${repository.error.detail}`);
  const disposable: SourceRunInput = { ...input, repositories: input.repositories.map((entry) => entry.key === primary.key
    ? { ...entry, preparation: { ...entry.preparation, repository_path: repository.value.path } } : entry) };
  return {
    run: async (label, options) => {
      const report = await sourceRunScenario(io, { input: disposable, directory: join(directory, `source-run-${label}`), through: "assessment", ...options });
      return { report, run: report.evidence.runs[0] ?? null };
    },
    repository_key: primary.key,
    readCited: (commit_sha, path) => repository.value.readAt(commit_sha, path),
    withholdRepository: () => repository.value.withhold(),
    supplyRepository: () => repository.value.supply(),
  };
}

/** The grading proof's real runs, each on the same disposable clone so the assessed run's repository can be withheld. */
async function gradingSource(io: ProofIo, input: SourceRunInput, directory: string, proof_id: string): Promise<GradingSource> {
  const primary = input.repositories.find((repository) => repository.key === input.primary_repository_key);
  if (!primary) throw new Error(`the input names no ${input.primary_repository_key} repository`);
  const repository = await createDisposableRepository(primary.preparation.repository_path, join(tmpdir(), "oakridge-proof", proof_id));
  if (!repository.ok) throw new Error(`${repository.error.operation}: ${repository.error.detail}`);
  const disposable: SourceRunInput = { ...input, repositories: input.repositories.map((entry) => entry.key === primary.key
    ? { ...entry, preparation: { ...entry.preparation, repository_path: repository.value.path } } : entry) };
  return {
    run: async (label, options) => {
      const chosen = options.input ? { ...options.input, repositories: options.input.repositories.map((entry) => entry.key === primary.key
        ? { ...entry, preparation: { ...entry.preparation, repository_path: repository.value.path } } : entry) } : disposable;
      const report = await sourceRunScenario(io, { input: chosen, directory: join(directory, `source-run-${label}`), through: options.through,
        capture: options.capture, after_launch: options.after_launch, grading_enabled: options.grading_enabled, reviews: options.reviews,
        target_units: options.target_units, timeout_ms: options.timeout_ms });
      return { report, run: report.evidence.runs[0] ?? null };
    },
    withholdRepository: () => repository.value.withhold(),
    supplyRepository: () => repository.value.supply(),
    /** The shadow's own observation database under its provisioned role, the shadow's tenant, the
     * validated default controls the shadow's service runs with, and the real provider settings. */
    async secondWorker() {
      const fail = (detail: string) => err({ operation: "second_worker", entity_id: io.state.observation.database, detail });
      const password = (await Bun.file(join(io.state.state_dir, "observation-database.password")).text().catch(() => "")).trim();
      if (!password) return fail("the shadow's observation database password is missing");
      const controls = gradingControls({});
      if (!controls.ok) return fail(controls.error.detail);
      const database = encodeURIComponent(io.state.observation.database);
      const db = openDatabase(`postgres://${database}:${encodeURIComponent(password)}@127.0.0.1:${io.state.postgres.port}/${database}`);
      return ok({ db, tenant: { producer: "oakridge", namespace: io.state.observation.namespace }, run_spend: controls.value.run_spend,
        lease_ms: controls.value.lease_ms, runners: registryRunners(controls.value, await providerSettings(io)), close: () => db.destroy() });
    },
  };
}

/** The late-link proof's real run on a disposable clone, and its composite reads on the shadow's own database. */
function relationsSource(io: ProofIo, grading: GradingSource, shared_input: SourceRunInput): RelationsSource {
  return { run: grading.run, shared_input, async openObservation() {
    const password = (await Bun.file(join(io.state.state_dir, "observation-database.password")).text().catch(() => "")).trim();
    if (!password) return err({ operation: "open_observation", entity_id: io.state.observation.database, detail: "the shadow's observation database password is missing" });
    const database = encodeURIComponent(io.state.observation.database);
    const db = openDatabase(`postgres://${database}:${encodeURIComponent(password)}@127.0.0.1:${io.state.postgres.port}/${database}`);
    return ok({ db, tenant: { producer: "oakridge", namespace: io.state.observation.namespace }, close: () => db.destroy() });
  } };
}

async function main(): Promise<number> {
  const { values, positionals } = parseArgs({ allowPositionals: true, options: { input: { type: "string" }, "shared-input": { type: "string" }, through: { type: "string" } } });
  const [command] = positionals;
  if (command !== "runtime" && command !== "live" && command !== "source-run" && command !== "registration" && command !== "grading" && command !== "relations" && command !== "workspace") {
    console.error("usage: proof.ts runtime | live | source-run --input <file> [--through analysis|plan|brief|assessment] | registration --input <file> | grading --input <file> | relations --input <file> --shared-input <file> | workspace --input <file>");
    return 2;
  }
  const proof_id = `${command}-${new Date().toISOString().replaceAll(/[:.]/g, "-")}`;
  const directory = join(REPORT_ROOT, proof_id);
  await mkdir(directory, { recursive: true });
  const state = await readLauncherState();
  const source = readSourceIdentity();
  const now = () => new Date();
  if (!state.ok) {
    const { text } = await runProof({ proof_id, scenario_id: command, source, launcher: null, now, secrets: async () => [],
      scenario: async () => ({ id: command, status: "failed", evidence: NO_EVIDENCE,
        checks: [{ name: "the shadow's state resolves", passed: false, detail: state.error.detail }] }) });
    console.error(`failed: ${await writeReport(directory, text)}`);
    return 1;
  }
  const io = createShadowIo(state.value, join(directory, "launcher.log"));
  const scenario = async (): Promise<ScenarioReport> => {
    if (command === "runtime") return runtimeScenario(io);
    if (command === "live") return liveScenario(io);
    if (!values.input) throw new Error(`${command} needs --input`);
    const input = sourceRunInputSchema.parse(await Bun.file(values.input).json());
    if (command === "registration") return registrationScenario(io, await registrationSource(io, input, directory, proof_id));
    if (command === "grading") return gradingScenario(io, await gradingSource(io, input, directory, proof_id));
    if (command === "workspace") return workspaceScenario(io, { ...await gradingSource(io, input, directory, proof_id), directory });
    if (command === "relations") {
      if (!values["shared-input"]) throw new Error("relations needs --shared-input");
      const shared = sourceRunInputSchema.parse(await Bun.file(values["shared-input"]).json());
      return relationsScenario(io, relationsSource(io, await gradingSource(io, input, directory, proof_id), shared), `${state.value.observation.namespace}-matrix-${proof_id}`);
    }
    const through = values.through ?? "brief";
    if (through !== "analysis" && through !== "plan" && through !== "brief" && through !== "assessment") throw new Error("invalid --through");
    if (!await io.stackAnswers()) {
      const started = await io.startStack();
      if (!started.ok) throw new Error(started.error.detail);
    }
    try {
      return await sourceRunScenario(io, { input, directory: join(directory, "source-run"), through: through satisfies SourceRunTarget });
    } finally { await io.stopStack(); }
  };
  const { report, text } = await runProof({ proof_id, scenario_id: command, source, launcher: state.value, scenario, now, secrets: () => secretValues(io) });
  const path = await writeReport(directory, text);
  for (const check of report.scenario.checks) console.info(`${check.passed ? "ok  " : "FAIL"} ${check.name}: ${check.detail}`);
  console.info(`${report.status}: ${path}`);
  return report.status === "passed" ? 0 : 1;
}

if (import.meta.main) process.exit(await main());
