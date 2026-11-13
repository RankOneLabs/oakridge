/**
 * The operator proof, on the shadow's real services and its real PWA. One assessment finding goes from
 * a fresh service through startup registration, ordered capture, exact evidence and a real configured
 * provider's answer to an authenticated human answer, both read back in the browser with no task or
 * cohort in the address. Around it: a selected question refused for its own readiness alone, human
 * answers with automatic grading off, spoofing, duplicates, correction history, capability separation,
 * unchanged authority and provider counts, hidden and revealed views, and every viewer entry point.
 *
 * Budget, lease, replay, pin swap and shared-task reads stay in `grading` and `relations`, which run on
 * this same state. Integration publication needs an operator's merge, so a real integration finding is
 * not reachable here; see PENDING_SCENARIOS.
 */
import { Hono } from "hono";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { mountObservationProxyRoutes } from "../../kbbl/core/server/handlers/observation-proxy";
import { readNotReadyPanel, readWorkspace, type ReadbackResult } from "../../kbbl/tests/browser/grading-readback";
import { isCommittedDefinition } from "../../workflow-config/src/definition-store";
import { NO_EVIDENCE, scenarioStatus, type GradingCounts, type HumanSubmissionReadback, type MeasurementReadback, type ProofCheck, type RunReference, type ScenarioReport, type DefinitionScan } from "./proof-contract";
import { readRunMeasurements, readSpend, readUntil, settledRun, type GradingSource } from "./grading";
import { authorityEvents } from "./relations";
import { awaitRunCapture, runCaptureChecks } from "./run-capture";
import { observationSettled, settleObservation } from "./scenarios";
import type { ProofIo } from "./shadow-session";

const REVIEWER = "oakridge-operator";
const DEFINITIONS = resolve(import.meta.dir, "../../workflow-config/definitions");
const CHOICES: Readonly<Record<string, readonly [string, string]>> = {
  "finding.relevance": ["unclear", "relevant"],
  "assessment_finding.correctness": ["contradicted", "supported"],
  "assessment_finding.evidence_support": ["does_not_support", "supports"],
};
const POLL_MS = 2_000;
const check = (name: string, passed: boolean, detail: string): ProofCheck => ({ name, passed, detail });
const phase = (name: string): void => { console.info(`[workspace ${new Date().toISOString()}] ${name}`); };

export interface WorkspaceSource extends Pick<GradingSource, "run" | "withholdRepository" | "supplyRepository"> { readonly directory: string }

interface KbblResponse { readonly status: number; readonly body: unknown }
type Kbbl = (path: string, init?: RequestInit) => Promise<KbblResponse>;
const kbblClient = (io: ProofIo): Kbbl => async (path, init) => {
  const response = await fetch(`${io.state.kbbl.url}/oakridge/observation${path}`, { ...init, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
};
const post = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
const itemPath = (occurrence_id: string) => `/items/${encodeURIComponent(occurrence_id)}`;

interface ServedAck { readonly error?: { readonly code?: string }; readonly reviewer_id?: string; readonly observation_id?: string; readonly execution_id?: string; readonly evidence_set_id?: string; readonly corrects_observation_id?: string | null }
const submissionOf = (label: string, submission_id: string, response: KbblResponse): HumanSubmissionReadback => {
  const body = (response.body ?? {}) as ServedAck;
  return { label, status: response.status, code: body.error?.code ?? null, submission_id, reviewer_id: body.reviewer_id ?? null, observation_id: body.observation_id ?? null,
    execution_id: body.execution_id ?? null, evidence_set_id: body.evidence_set_id ?? null, corrects_observation_id: body.corrects_observation_id ?? null };
};

/** Everything the human path must have done, judged from what the services returned. */
export function humanAnswerChecks(input: { readonly submissions: readonly HumanSubmissionReadback[]; readonly machine_evidence_set_id: string | null;
  readonly before: GradingCounts; readonly after_first: GradingCounts; readonly after_duplicate: GradingCounts; readonly after_correction: GradingCounts }): readonly ProofCheck[] {
  const of = (label: string) => input.submissions.find((submission) => submission.label === label) ?? null;
  const first = of("first"), spoofed = of("spoofed"), duplicate = of("duplicate"), correction = of("correction");
  return [
    check("an authenticated human answer is acknowledged with the credential's reviewer", first?.status === 201 && first.reviewer_id === REVIEWER && first.observation_id !== null, JSON.stringify(first)),
    check("it shares the frozen evidence the machine answer used", first !== null && first.evidence_set_id !== null && first.evidence_set_id === input.machine_evidence_set_id, `${first?.evidence_set_id} and ${input.machine_evidence_set_id}`),
    check("browser reviewer and evaluator fields impersonate nobody", spoofed?.reviewer_id === REVIEWER, JSON.stringify(spoofed)),
    check("a duplicate submission id acknowledges the original and changes nothing", duplicate?.status === 200 && duplicate.observation_id === first?.observation_id
      && JSON.stringify(input.after_duplicate) === JSON.stringify(input.after_first), `${JSON.stringify(input.after_first)} then ${JSON.stringify(input.after_duplicate)}`),
    check("a correction appends one linked answer on the same evidence", correction?.status === 201 && correction.corrects_observation_id === first?.observation_id && correction.evidence_set_id === first?.evidence_set_id
      && input.after_correction.observations === input.after_duplicate.observations + 1, JSON.stringify(correction)),
    check("no human answer or correction sent a provider request", input.after_correction.requests_sent === input.before.requests_sent, `${input.before.requests_sent} then ${input.after_correction.requests_sent}`),
    check("no human answer or correction wrote an authority event", input.before.authority_events !== null && input.after_correction.authority_events === input.before.authority_events, `${input.before.authority_events} then ${input.after_correction.authority_events}`),
  ];
}

/** Every stored definition file: workflows, operation registries and the launchable list. Prompts are text, not definitions. */
const storedDefinitionFiles = (root: string): readonly string[] => [
  ...["workflows", "operations"].flatMap((directory) => readdirSync(join(root, directory)).filter((name) => name.endsWith(".json")).map((name) => join(directory, name))),
  ...(readdirSync(root).includes("launchable.json") ? ["launchable.json"] : []),
];
const namesGatedReview = (value: unknown): boolean => Array.isArray(value) ? value.some(namesGatedReview)
  : typeof value === "object" && value !== null ? Object.entries(value).some(([key, member]) => key === "gated_review" || namesGatedReview(member)) : false;

/** Scans every retained definition for schema compatibility, and every stored definition file for any gated_review key. */
export function scanDefinitions(root: string = DEFINITIONS): DefinitionScan {
  const workflows = readdirSync(join(root, "workflows")).filter((name) => name.endsWith(".json"));
  const stored = storedDefinitionFiles(root);
  return { scanned: workflows.length,
    with_discarded_field: workflows.filter((name) => !isCommittedDefinition(JSON.parse(readFileSync(join(root, "workflows", name), "utf8")))),
    files_scanned: stored.length, files_naming_gated_review: stored.filter((file) => namesGatedReview(JSON.parse(readFileSync(join(root, file), "utf8")))) };
}

export async function workspaceScenario(io: ProofIo, source: WorkspaceSource): Promise<ScenarioReport> {
  if (await io.stackAnswers()) return { id: "workspace", status: "failed", evidence: NO_EVIDENCE,
    checks: [check("this proof owns the stack", false, "a shadow is already running; this proof restarts it")] };
  const checks: ProofCheck[] = [];
  const runs: RunReference[] = [];
  const kbbl = kbblClient(io);
  const screenshots = join(source.directory, "screenshots");
  const browserSteps: ProofCheck[] = [];
  const browserShots: string[] = [];
  const recordBrowser = (result: ReadbackResult): void => {
    browserSteps.push(...result.steps);
    browserShots.push(...result.screenshots);
    checks.push(...result.steps.map((step) => check(`browser: ${step.name}`, step.passed, step.detail)));
  };
  const submissions: HumanSubmissionReadback[] = [];
  const counts: Record<string, GradingCounts> = {};
  let measurements: readonly MeasurementReadback[] = [];
  let target: MeasurementReadback | null = null;
  let composite: unknown = null;
  let spendRequests: number | null = null;
  const definition_scan = scanDefinitions();
  const finish = (): ScenarioReport => ({ id: "workspace", status: scenarioStatus(checks), checks, evidence: { ...NO_EVIDENCE, runs, measurements,
    source_revisions: target ? [target.revision_id] : [], item_paths: target ? [`${target.revision_id}${target.item_path}`] : [],
    pinned_definitions: target ? [target.evaluator_definition_id] : [], execution_ids: [...new Set(measurements.flatMap((entry) => entry.execution_id ? [entry.execution_id] : []))],
    provider_attempt_ids: measurements.flatMap((entry) => entry.attempts.map((attempt) => `${entry.execution_id}#${attempt.attempt}`)),
    observation_ids: [...measurements.flatMap((entry) => entry.observation_id ? [entry.observation_id] : []), ...submissions.flatMap((entry) => entry.observation_id ? [entry.observation_id] : [])],
    provider_request_count: spendRequests, pwa_readback: browserSteps.filter((step) => step.passed).map((step) => step.name),
    workspace: { source_run_id: runs.at(-1)?.run_id ?? null, source_revision_id: target?.revision_id ?? null, item_path: target?.item_path ?? null, occurrence_id: target?.occurrence_id ?? null,
      question_id: target?.question_id ?? null, evidence_set_id: target?.evidence_set_id ?? null,
      machine: target ? { evaluator_definition_id: target.evaluator_definition_id, execution_id: target.execution_id, observation_id: target.observation_id, attempts: target.attempts } : null,
      submissions, counts, composite, browser: { steps: browserSteps, screenshots: browserShots }, definition_scan } } });
  const countsOf = async (run_id: string): Promise<GradingCounts> => {
    const spend = await readSpend(io, run_id, "counts");
    const count = async (table: string): Promise<number> => {
      const read = await io.shadowQuery(io.state.observation.database, `SELECT count(*) FROM observation.${table}`);
      if (!read.ok) throw new Error(read.error.detail);
      return Number(read.value);
    };
    return { observations: await count("grade_observation"), executions: await count("evaluation_execution"), requests_sent: spend.requests_sent, authority_events: await authorityEvents(io, run_id) };
  };
  const startStack = async (checkpoint: string): Promise<boolean> => {
    const started = await io.startStack();
    checks.push(check(`the stack starts (${checkpoint})`, started.ok, started.ok ? "answered" : started.error.detail));
    if (!started.ok) return false;
    const settled = await settleObservation(io);
    const health = await io.kbblHealth();
    const graders = health?.observation.state === "configured" ? health.observation.graders : [];
    checks.push(check(`startup registered the configured graders (${checkpoint})`, observationSettled(settled.health) && graders.length > 0, graders.map((grader) => `${grader.runner}:${grader.evaluatorDefinitionId}`).join(", ") || settled.health));
    checks.push(check(`kbbl holds both capabilities and returns no token (${checkpoint})`, Boolean(health?.capabilities.read && health.capabilities.grade), JSON.stringify(health?.capabilities ?? null)));
    return observationSettled(settled.health);
  };
  const stopObservation = async (name: string): Promise<ProofCheck> => {
    const status = await io.observationStatus();
    const pid = Number(/^pid_(\d+)$/.exec(status?.detail ?? "")?.[1]);
    if (!pid) return check(name, false, `no running service recorded: ${JSON.stringify(status)}`);
    io.killObservation(pid);
    let health = await io.kbblHealth();
    for (let attempt = 0; attempt < 30 && health?.observation.state !== "down"; attempt++) { await io.sleep(POLL_MS); health = await io.kbblHealth(); }
    return check(name, health?.observation.state === "down" && await io.dbosHealthy(), JSON.stringify(health?.observation ?? null));
  };
  const answer = (occurrence_id: string, label: string, body: { readonly question_id: string; readonly question_version: string; readonly answer: string; readonly submission_id?: string; readonly [field: string]: unknown }) => {
    const submission_id = body.submission_id ?? `${label}-${crypto.randomUUID()}`;
    return kbbl(`${itemPath(occurrence_id)}/answers`, post({ ...body, submission_id })).then((response) => { const read = submissionOf(label, submission_id, response); submissions.push(read); return read; });
  };

  checks.push(check("no retained definition carries a discarded review field", definition_scan.scanned > 0 && definition_scan.with_discarded_field.length === 0 && definition_scan.files_naming_gated_review.length === 0,
    `${definition_scan.scanned} workflows and ${definition_scan.files_scanned} stored files scanned: ${[...definition_scan.with_discarded_field, ...definition_scan.files_naming_gated_review].join(", ") || "none carry one"}`));
  try {
    if (!await startStack("fresh")) return finish();

    phase("grading-off run");
    // 1. Grading off: evidence for a reviewer and nothing sent, and a human answer still accepted.
    const off = await source.run("analysis-off", { grading_enabled: false, through: "analysis", capture: "await" });
    checks.push(check("the grading-off run reaches its analysis", off.report.status === "passed" && off.run !== null, off.run?.run_id ?? JSON.stringify(off.report.checks.filter((entry) => !entry.passed))));
    if (!off.run) return finish();
    runs.push(off.run);
    const offRead = await readUntil(io, off.run.run_id, "off", (read) => read.length > 0 && read.every((entry) => !(entry.state === "not_ready" && entry.detail === "collection_pending")));
    const offItem = offRead.find((entry) => entry.is_human_ready);
    if (!offItem) { checks.push(check("a grading-off finding is ready for a reviewer", false, JSON.stringify(offRead.map((entry) => entry.state)))); return finish(); }
    checks.push(check("automatic grading off reads as grading_off, not as a negative answer", offItem.state === "grading_off", offItem.state));
    const offAnswer = await answer(offItem.occurrence_id, "grading-off", { question_id: offItem.question_id, question_version: offItem.question_version, answer: CHOICES[offItem.question_id]?.[0] ?? "unclear" });
    const offSpend = await readSpend(io, off.run.run_id, "off");
    checks.push(check("a human answer is accepted with automatic grading off, and no request is sent", offAnswer.status === 201 && offSpend.requests_sent === 0, `${offAnswer.status}; ${offSpend.requests_sent} request(s)`));

    phase("enabled run, repository withheld");
    // 2. An enabled run captured with its repository withheld: file-citing questions wait, each on its own.
    const assessed = await source.run("assessment-on", { grading_enabled: true, through: "assessment", capture: "deferred",
      reviews: [{ review: "plan_review", revision_feedback: "Revise the plan's summary wording; change nothing else." }],
      after_launch: () => stopObservation("observation is down while the assessed run progresses, and DBOS keeps serving") });
    await io.stopStack();
    checks.push(check("the enabled run reaches its assessment, with an accepted and a sent-back review", assessed.report.status === "passed" && assessed.run !== null, assessed.run?.run_id ?? JSON.stringify(assessed.report.checks.filter((entry) => !entry.passed))));
    if (!assessed.run) return finish();
    const run = assessed.run;
    runs.push(run);
    const withheld = await source.withholdRepository();
    checks.push(check("the repository is withheld from observation", withheld.ok, withheld.ok ? withheld.value : withheld.error.detail));
    if (!withheld.ok || !await startStack("repository withheld")) return finish();
    checks.push(...runCaptureChecks(await awaitRunCapture(io, { run_id: run.run_id, target_artifact: "assessment" })));
    const waiting = await readUntil(io, run.run_id, "withheld", settledRun);
    const reviewerObservations = await io.shadowQuery(io.state.observation.database, `SELECT count(*) FROM observation.grade_observation g JOIN observation.evaluation_execution x USING (producer, namespace, execution_id) WHERE g.reviewer_id IS NOT NULL AND x.run_id = '${run.run_id}'`);
    checks.push(check("accepting and sending back reviews created no grade", reviewerObservations.ok && Number(reviewerObservations.value) === 0, reviewerObservations.ok ? `${reviewerObservations.value} reviewer answer(s)` : reviewerObservations.error.detail));
    const notReady = waiting.find((entry) => entry.state === "not_ready" && !entry.is_human_ready && entry.item_kind === "assessment_finding");
    if (!notReady) { checks.push(check("a question waits on the withheld repository", false, JSON.stringify(waiting.map((entry) => entry.state)))); return finish(); }
    const refused = await answer(notReady.occurrence_id, "not-ready", { question_id: notReady.question_id, question_version: notReady.question_version, answer: CHOICES[notReady.question_id]?.[0] ?? "unclear" });
    checks.push(check("a not-ready question refuses its answer with its own reason", refused.status === 409 && refused.code === "not_ready" && refused.observation_id === null, JSON.stringify(refused)));
    const readyElsewhere = waiting.find((entry) => entry.is_human_ready && entry.item_kind === "finding") ?? waiting.find((entry) => entry.is_human_ready);
    if (readyElsewhere) {
      const accepted = await answer(readyElsewhere.occurrence_id, "ready-beside", { question_id: readyElsewhere.question_id, question_version: readyElsewhere.question_version, answer: CHOICES[readyElsewhere.question_id]?.[0] ?? "unclear" });
      checks.push(check("a ready question stays answerable beside it", accepted.status === 201, JSON.stringify(accepted)));
    } else checks.push(check("a ready question stays answerable beside it", false, "no question was ready"));
    const addressOf = (entry: MeasurementReadback) => ({ source_revision_id: entry.revision_id, item_path: entry.item_path });
    recordBrowser(await readNotReadyPanel({ kbbl_url: io.state.kbbl.url, run_id: run.run_id, screenshot_dir: screenshots, item: addressOf(notReady), question_id: notReady.question_id, code: notReady.detail ?? "repository_unavailable" }));
    await io.stopStack();

    phase("repository supplied");
    // 3. The input arrives: real provider answers on the pins from capture.
    const supplied = await source.supplyRepository();
    checks.push(check("the repository is supplied", supplied.ok, supplied.ok ? supplied.value : supplied.error.detail));
    if (!supplied.ok || !await startStack("repository supplied")) return finish();
    measurements = await readUntil(io, run.run_id, "supplied", settledRun);
    const answered = measurements.filter((entry) => entry.state === "answered" && entry.item_kind === "assessment_finding" && entry.observation_id !== null && entry.attempts.some((attempt) => attempt.request_sent));
    checks.push(check("the configured provider answered assessment findings in real requests", answered.length > 0, `${answered.length} answered: ${answered.map((entry) => `${entry.execution_id}#${entry.attempts.length}`).slice(0, 5).join(", ")}`));
    if (answered.length === 0) return finish();
    const linkedTo = async (entry: MeasurementReadback) => ((await kbbl(`${itemPath(entry.occurrence_id)}/status`)).body as { readonly links?: { readonly total: number } } | null)?.links?.total ?? 0;
    let chosen = answered[0]!;
    for (const entry of answered) if (await linkedTo(entry) > 0) { chosen = entry; break; }
    target = chosen;
    const machineObservation = chosen.observation_id!;

    phase("human answers");
    // 4. Exact address and no task: kbbl resolves it, and the human path meets every boundary.
    const at = await kbbl(`/runs/${encodeURIComponent(run.run_id)}/items/at?source_revision_id=${encodeURIComponent(chosen.revision_id)}&item_path=${encodeURIComponent(chosen.item_path)}`);
    checks.push(check("exact revision and path resolve the occurrence, with no task or cohort", at.status === 200 && (at.body as { readonly occurrence_id?: string }).occurrence_id === chosen.occurrence_id, JSON.stringify(at.status)));
    const question = { question_id: chosen.question_id, question_version: chosen.question_version };
    const [negative, positive] = CHOICES[chosen.question_id] ?? ["unclear", "unclear"];
    const before = await countsOf(run.run_id);
    const invalid = await answer(chosen.occurrence_id, "invalid-choice", { ...question, answer: "not-a-choice" });
    checks.push(check("an answer outside the question's choices is refused", invalid.status === 422 && invalid.code === "invalid_answer", JSON.stringify(invalid)));
    const firstId = `first-${crypto.randomUUID()}`;
    const first = await answer(chosen.occurrence_id, "first", { ...question, answer: negative, submission_id: firstId, rationale: "Recorded by the live proof." });
    const after_first = await countsOf(run.run_id);
    const spoofed = await answer(chosen.occurrence_id, "duplicate", { ...question, answer: positive, submission_id: firstId, reviewer_id: "someone-else", evaluator_definition_id: chosen.evaluator_definition_id });
    const after_duplicate = await countsOf(run.run_id);
    const correction = await answer(chosen.occurrence_id, "correction", { ...question, answer: positive, corrects_observation_id: first.observation_id, rationale: "Corrected by the live proof." });
    const after_correction = await countsOf(run.run_id);
    submissions.push({ ...spoofed, label: "spoofed" });
    counts.before = before; counts.after_first = after_first; counts.after_duplicate = after_duplicate; counts.after_correction = after_correction;
    checks.push(...humanAnswerChecks({ submissions, machine_evidence_set_id: chosen.evidence_set_id, before, after_first, after_duplicate, after_correction }));

    phase("capabilities");
    // 5. Capabilities, and the forwarding routes under a control token, on the real service.
    const tokens = await io.tokens();
    if (!tokens.ok) { checks.push(check("the shadow's capabilities are readable", false, tokens.error.detail)); return finish(); }
    const statusRoute = `/v1/items/${encodeURIComponent(chosen.occurrence_id)}/status`;
    const gradeReads = await io.observationGet(statusRoute, "grade");
    const readWrites = await fetch(`${io.state.observation.url}/v1/items/${encodeURIComponent(chosen.occurrence_id)}/answers`, { ...post({ ...question, submission_id: "read-token", answer: positive }), headers: { "content-type": "application/json", authorization: `Bearer ${tokens.value.capabilities.read}` } });
    checks.push(check("a grade capability reads nothing, and a read capability writes nothing", !gradeReads.ok && readWrites.status === 403, `grade read ${gradeReads.ok ? "allowed" : "refused"}; read write ${readWrites.status}`));
    const guarded = new Hono();
    mountObservationProxyRoutes(guarded, { observation: { url: io.state.observation.url, namespace: io.state.observation.namespace, readToken: tokens.value.capabilities.read, gradeToken: tokens.value.capabilities.grade, configureToken: tokens.value.capabilities.configure }, browserControlToken: "proof-control-token", allowedOrigins: [] });
    const guardedRead = `/oakridge/observation${itemPath(chosen.occurrence_id)}/status`;
    const anonymous = await guarded.request(guardedRead);
    const operator = await guarded.request(guardedRead, { headers: { authorization: "Bearer proof-control-token" } });
    const anonymousWrite = await guarded.request(`/oakridge/observation${itemPath(chosen.occurrence_id)}/answers`, post({ ...question, submission_id: "anonymous", answer: positive }));
    checks.push(check("under a control token, kbbl's forwarding refuses before forwarding and admits the operator, against the real service", anonymous.status === 401 && anonymousWrite.status === 401 && operator.status === 200, `${anonymous.status}, ${anonymousWrite.status}, ${operator.status}`));

    phase("readback");
    // 6. Both answers read back, kept apart, with correction history; the composite follows the correction.
    const state = (await kbbl(`${itemPath(chosen.occurrence_id)}/status?limit=200&answers_limit=200&superseded_answers_limit=200`)).body as { readonly questions: { readonly items: readonly { readonly question: { readonly question_id: string }; readonly answers: { readonly items: readonly { readonly observation_id: string; readonly reviewer_id: string | null; readonly evaluator_definition_id: string }[] }; readonly superseded_answers: { readonly items: readonly { readonly observation_id: string }[] } }[] } };
    const served = state.questions.items.find((entry) => entry.question.question_id === chosen.question_id);
    checks.push(check("machine and human answers read back with distinct identities", Boolean(served?.answers.items.some((entry) => entry.observation_id === machineObservation && entry.reviewer_id === null)
      && served.answers.items.some((entry) => entry.observation_id === correction.observation_id && entry.reviewer_id === REVIEWER && entry.evaluator_definition_id !== chosen.evaluator_definition_id)), JSON.stringify(served?.answers.items.map((entry) => [entry.observation_id, entry.reviewer_id]) ?? null)));
    checks.push(check("the earlier human answer stays in history, not current", Boolean(served?.superseded_answers.items.some((entry) => entry.observation_id === first.observation_id)), first.observation_id ?? ""));
    const tasks = await kbbl(`/runs/${encodeURIComponent(run.run_id)}/tasks?limit=200&answers_limit=200&stages_limit=3`);
    composite = tasks.body;
    const counted = JSON.stringify(tasks.body);
    checks.push(check("composites count the corrected answer, by item and grader", tasks.status === 200 && counted.includes(`"value":"${positive}"`) && counted.includes(`"reviewer_id":"${REVIEWER}"`), `status ${tasks.status}`));

    phase("browser");
    // 7. The real browser.
    const browserFinding = measurements.find((entry) => entry.item_kind === "finding" && entry.state === "answered" && entry.occurrence_id !== readyElsewhere?.occurrence_id) ?? null;
    if (!browserFinding) { checks.push(check("an analysis finding is ready for a browser answer", false, "none")); return finish(); }
    const [browser_first_choice, browser_second_choice] = CHOICES[browserFinding.question_id] ?? ["unclear", "unclear"];
    const readback = await readWorkspace({ kbbl_url: io.state.kbbl.url, run_id: run.run_id, screenshot_dir: screenshots, answered: addressOf(chosen), answered_question_id: chosen.question_id,
      machine_observation_id: machineObservation, human_observation_id: correction.observation_id ?? "", browser_item: addressOf(browserFinding),
      hidden_markers: ["Recorded by the live proof.", "Corrected by the live proof.", "Reviewer oakridge-operator"], browser_first_choice, browser_second_choice });
    recordBrowser(readback);
    phase("browser finished");
    const authorityAfter = await authorityEvents(io, run.run_id);
    checks.push(check("browser answers write no authority event", authorityAfter === before.authority_events, `${before.authority_events} then ${authorityAfter}`));
    checks.push(check("browser answers bind the credential's reviewer and link the correction", readback.submissions.length === 2 && readback.submissions.every((entry) => entry.reviewer_id === REVIEWER)
      && readback.submissions[1]?.corrects_observation_id === readback.submissions[0]?.observation_id, JSON.stringify(readback.submissions)));
    measurements = await readRunMeasurements(io, run.run_id, "final");
    const finalSpend = await readSpend(io, run.run_id, "final");
    spendRequests = finalSpend.requests_sent;
    checks.push(check("the run's request count matches its sent attempts after every human answer", finalSpend.requests_sent === measurements.reduce((total, entry) => total + entry.attempts.filter((attempt) => attempt.request_sent).length, 0), `${finalSpend.requests_sent} request(s) in ${finalSpend.attempts} attempt(s)`));
    return finish();
  } finally {
    phase("stopping the stack");
    await io.stopStack();
    await source.supplyRepository();
  }
}
