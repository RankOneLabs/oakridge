/**
 * The scenarios of the one verification program. Each drives the stack that
 * scripts/oakridge-shadow started and reports what it observed.
 */
import { defaultModelForRuntime } from "../../kbbl/core/runtime";
import { resolveLaunchableDefinition } from "../../workflow-config/src/definition-store";
import { NO_EVIDENCE, scenarioStatus, type AuthorityCount, type CaptureReference, type ProofCheck, type RunReference,
  type ScenarioEvidence, type ScenarioId, type ScenarioReport } from "./proof-contract";
import type { ProofIo } from "./shadow-session";

const OBSERVATION_START_ATTEMPTS = 120;
const CAPTURE_CATCH_UP_ATTEMPTS = 240;
const POLL_MS = 500;

const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });
const report = (id: ScenarioId, checks: readonly ProofCheck[], evidence: ScenarioEvidence = NO_EVIDENCE): ScenarioReport =>
  ({ id, status: scenarioStatus(checks), checks, evidence });

async function poll<Value>(io: ProofIo, attempts: number, read: () => Promise<Value>, done: (value: Value) => boolean): Promise<Value> {
  let value = await read();
  for (let attempt = 0; attempt < attempts && !done(value); attempt += 1) {
    await io.sleep(POLL_MS);
    value = await read();
  }
  return value;
}

const observationSettled = (state: string | undefined) => state !== undefined && state !== "not_configured" && state !== "down";

/** Waits for the service or its recorded failure, whichever is first, and returns what health then says. */
async function settleObservation(io: ProofIo): Promise<{ readonly health: string; readonly launcher: string }> {
  const health = await poll(io, OBSERVATION_START_ATTEMPTS, async () => ({ health: await io.kbblHealth(), status: await io.observationStatus() }),
    ({ health: current, status }) => observationSettled(current?.observation.state) || status?.state === "preflight_failed" || status?.state === "exited");
  const launcher = health.status ? `${health.status.state}${health.status.detail ? `: ${health.status.detail}` : ""}` : "no status recorded";
  return { health: health.health?.observation.state ?? "kbbl_unavailable", launcher };
}

async function isolationChecks(io: ProofIo): Promise<readonly ProofCheck[]> {
  const { state } = io;
  const tokens = await io.tokens();
  const distinct = tokens.ok && new Set(Object.values(tokens.value.capabilities)).size === 3;
  const connected = await io.shadowQuery(state.postgres.authority_database,
    `SELECT count(*) FROM pg_stat_activity WHERE datname = '${state.observation.database}' AND usename = '${state.observation.database}'`);
  const role = await io.shadowQuery(state.postgres.authority_database, `SELECT rolsuper FROM pg_roles WHERE rolname = '${state.observation.database}'`);
  const baseline = await io.shadowQuery(state.observation.database, "SELECT count(*) FROM observation.schema_baseline");
  const ports = [state.kbbl.port, state.dbos.port, state.postgres.port, state.observation.port];
  return [
    check("capabilities are distinct and private", distinct && tokens.value.private_files, tokens.ok ? `private: ${tokens.value.private_files}` : tokens.error.detail),
    check("the shadow's ports are distinct", new Set(ports).size === ports.length, ports.join(",")),
    check("the service holds a connection in the shadow's PostgreSQL", connected.ok && Number(connected.value) > 0, connected.ok ? `${connected.value} connection(s)` : connected.error.detail),
    check("it connects as an ordinary role", role.ok && role.value === "f", role.ok ? `rolsuper=${role.value}` : role.error.detail),
    check("the target baseline is recorded once", baseline.ok && baseline.value === "1", baseline.ok ? baseline.value : baseline.error.detail),
  ];
}

const countEvents = async (io: ProofIo): Promise<number | null> => {
  const counted = await io.shadowQuery(io.state.postgres.authority_database, "SELECT count(*) FROM authority.event");
  return counted.ok ? Number(counted.value) : null;
};

/** A real run: its launch and cancellation commit while observation is gone. */
async function progressWorkflow(io: ProofIo): Promise<{ readonly checks: readonly ProofCheck[]; readonly run: RunReference | null; readonly authority: AuthorityCount }> {
  const events_before = await countEvents(io);
  const definition = resolveLaunchableDefinition("review-loop");
  if (!definition.ok) return { checks: [check("a launchable definition is available", false, JSON.stringify(definition.error))],
    run: null, authority: { events_before, events_after: null } };
  const { definition_id } = definition.value;
  const settings = { harness: "codex", model: defaultModelForRuntime("codex"), effort: null };
  const launched = await io.dbos("/api/runs", { request_id: crypto.randomUUID(), definition_id, input: { topic: "runtime verification" },
    config: { sessions: { document: { writer: settings, critic: settings } } } });
  const run_id = launched.ok ? (launched.value as { readonly run_id?: string }).run_id ?? null : null;
  if (!run_id) return { checks: [check("a run launches while observation is down", false, launched.ok ? "no run id" : launched.error.detail)],
    run: null, authority: { events_before, events_after: await countEvents(io) } };
  const canceled = await io.dbos(`/api/runs/${run_id}/cancel`, { request_id: crypto.randomUUID() });
  const events_after = await countEvents(io);
  return { run: { run_id, definition_id }, authority: { events_before, events_after }, checks: [
    check("a run launches while observation is down", true, run_id),
    check("it can be canceled while observation is down", canceled.ok, canceled.ok ? "accepted" : canceled.error.detail),
    check("the authority committed its events", events_before !== null && events_after !== null && events_after > events_before, `${events_before} -> ${events_after}`),
  ] };
}

export async function readCapture(io: ProofIo): Promise<CaptureReference> {
  const head = await io.shadowQuery(io.state.postgres.authority_database,
    "SELECT commit_txid::text || '/' || id FROM authority.event ORDER BY commit_txid DESC, id DESC LIMIT 1");
  const cursor = await io.observationGet("/v1/sources/oakridge/cursor", "ingest");
  const position = cursor.ok ? (cursor.value as { readonly cursor?: { readonly commit_txid: string; readonly id: string } }).cursor : undefined;
  return { authority_head: head.ok ? head.value : null, service_cursor: position ? `${position.commit_txid}/${position.id}` : null };
}

/**
 * Isolation and supervision on the real stack: the shadow's own state, an
 * observation death the stack survives, workflow progress through it, and a
 * restart that reuses the same state and catches the ordered feed up.
 */
export async function runtimeScenario(io: ProofIo): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return report("runtime", [check("this proof owns the stack", false, "a shadow is already running; it stops and restarts one itself")]);
  const started = await io.startStack();
  if (!started.ok) return report("runtime", [check("the stack starts", false, started.error.detail)]);
  const checks: ProofCheck[] = [check("the stack starts", true, "DBOS and kbbl answered")];
  try {
    const settled = await settleObservation(io);
    checks.push(check("observation is reachable", observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`));
    if (!observationSettled(settled.health)) return report("runtime", checks);
    checks.push(...await isolationChecks(io));
    const tokens_before = await io.tokens();

    const status = await io.observationStatus();
    const pid = Number(/^pid_(\d+)$/.exec(status?.detail ?? "")?.[1]);
    if (!pid) { checks.push(check("the launcher recorded the service", false, JSON.stringify(status))); return report("runtime", checks); }
    io.killObservation(pid);
    const down = await poll(io, OBSERVATION_START_ATTEMPTS, () => io.kbblHealth(), (health) => health?.observation.state === "down");
    checks.push(check("kbbl reports observation down after it dies", down?.observation.state === "down", JSON.stringify(down?.observation ?? null)));
    checks.push(check("DBOS keeps serving", await io.dbosHealthy(), "health"));
    const progress = await progressWorkflow(io);
    checks.push(...progress.checks);

    await io.stopStack();
    const restarted = await io.startStack();
    checks.push(check("the stack restarts", restarted.ok, restarted.ok ? "answered" : restarted.error.detail));
    if (!restarted.ok) return report("runtime", checks, { ...NO_EVIDENCE, authority: progress.authority, runs: progress.run ? [progress.run] : [] });
    const resettled = await settleObservation(io);
    checks.push(check("observation returns on the same state", observationSettled(resettled.health), `health ${resettled.health}; launcher ${resettled.launcher}`));
    const tokens_after = await io.tokens();
    checks.push(check("capabilities survive the restart", tokens_before.ok && tokens_after.ok
      && JSON.stringify(tokens_before.value.capabilities) === JSON.stringify(tokens_after.value.capabilities), "compared by value, not reported"));
    const capture = await poll(io, CAPTURE_CATCH_UP_ATTEMPTS, () => readCapture(io), (position) => position.authority_head !== null && position.authority_head === position.service_cursor);
    checks.push(check("ordered delivery catches up to the authority", capture.authority_head !== null && capture.authority_head === capture.service_cursor,
      `head ${capture.authority_head}, cursor ${capture.service_cursor}`));
    return report("runtime", checks, { ...NO_EVIDENCE, runs: progress.run ? [progress.run] : [], authority: progress.authority, capture });
  } finally { await io.stopStack(); }
}

/**
 * The real-provider proof's prerequisites. A missing key, invalid grader or
 * unavailable database leaves the stack up and this scenario failed: a healthy
 * DBOS and kbbl are not grading capability.
 */
export async function liveScenario(io: ProofIo): Promise<ScenarioReport> {
  const attached = await io.stackAnswers();
  const started = attached ? null : await io.startStack();
  if (started && !started.ok) return report("live", [check("the stack starts", false, started.error.detail)]);
  try {
    const settled = await settleObservation(io);
    const health = await io.kbblHealth();
    const graders = health?.observation.state === "configured" ? health.observation.graders : [];
    return report("live", [
      check("observation is reachable", observationSettled(settled.health), `health ${settled.health}; launcher ${settled.launcher}`),
      check("the service registered its configured graders", graders.length > 0,
        graders.length > 0 ? graders.map((grader) => grader.runner).join(",") : `health ${settled.health}; launcher ${settled.launcher}`),
      check("kbbl holds both capabilities", Boolean(health?.capabilities.read && health.capabilities.grade), JSON.stringify(health?.capabilities ?? null)),
    ]);
  } finally { if (!attached) await io.stopStack(); }
}
