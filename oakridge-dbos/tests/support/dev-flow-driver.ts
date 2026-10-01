/**
 * Public operator actions plus the fake ACP process used by the harness.
 *
 * The agent emits artifacts through the work-order emit route. The operator
 * approves gates through the gate resume route, and confirms a merge through
 * the cohort pull request route — the same one the GitHub poller posts its
 * observations to. Nothing here reaches around the HTTP surface into a
 * workflow, because a message a test can post but production cannot is exactly
 * how a deadlock ships green.
 */
import { expect } from "bun:test";
import { agent, ndJsonStream, PROTOCOL_VERSION, type AgentContext } from "@agentclientprotocol/sdk";
import { Readable, Writable } from "node:stream";

import type { OperatorArtifactDetail, OperatorParkedGate, OperatorRunDetail, OperatorRunSummary, OperatorReviewInbox } from "../../src/domain/operator-projections";
import type { ArtifactId, JsonValue, UnitId, WorkflowDefinitionId, WorkflowRunId } from "../../src/domain/primitives";
import { sendRunWakeHint } from "../../src/http/dbos-transport";
import type { SqlExecutor } from "../../src/storage/sql-executor";
import { awaitCondition, cohortHeadBranch, cohortPullRequestUrl, type ScriptedAgentScenario } from "./dev-flow-harness";

const readJson = async <Value>(response: Response, describe: string): Promise<Value> => {
  const text = await response.text();
  if (!response.ok) throw new Error(`${describe} failed: ${response.status} ${text}`);
  return JSON.parse(text) as Value;
};

export interface LaunchedRun {
  readonly run_id: OperatorRunSummary["id"];
  readonly root_workflow_id: string;
}

/**
 * Launches a run the way the operator surface does, and waits for it to start.
 *
 * `context` is supplied rather than defaulted because a run is defined by the
 * repositories it names — a caller proving what happens to a repository that
 * cannot be provisioned has to be able to name that one.
 */
export const launchRun = async (baseUrl: string, definitionId: WorkflowDefinitionId, context: JsonValue): Promise<LaunchedRun> => {
  const response = await fetch(`${baseUrl}/workflow_runs`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ workflow_def_id: definitionId, context }),
  });
  const summary = await readJson<OperatorRunSummary>(response, "run launch");
  return { run_id: summary.id, root_workflow_id: summary.current_attempt_root_workflow_id };
};

/** The gate an artifact is parked in, once the operator surface shows it. */
export const awaitPendingGate = async (baseUrl: string, artifactId: ArtifactId, timeoutMs = 30_000): Promise<OperatorParkedGate> =>
  awaitCondition(`a pending gate for artifact ${artifactId}`, async () => {
    const gates = await readJson<readonly OperatorParkedGate[]>(await fetch(`${baseUrl}/gates`), "list pending gates");
    return gates.find((gate) => gate.artifact_revision_id === artifactId) ?? null;
  }, timeoutMs);

/**
 * The operator's decision on a parked gate.
 *
 * For the assessor this is also what resolves the build's handoff: the gate's
 * `revision_target` is `upstream_handoff`, so the same request that decides the
 * assessment carries the downstream decision back to the build unit that has
 * been waiting on it. That routing is the route's job, and driving it here is
 * the point — it is the edge no test had ever exercised.
 */
export const decideGate = async (baseUrl: string, artifactId: ArtifactId, action: string): Promise<OperatorParkedGate> => {
  const gate = await awaitPendingGate(baseUrl, artifactId);
  if (!gate.resume_actions.includes(action)) throw new Error(`gate ${gate.id} does not offer action '${action}': ${gate.resume_actions.join(", ")}`);
  const response = await fetch(`${baseUrl}/gates/${gate.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: `${action}:${artifactId}`, artifact_revision_id: artifactId,
      gate_step: gate.gate_step, action, operator_comment: `integration test ${action}` }),
  });
  await readJson(response, `resume gate ${gate.id}`);
  return gate;
};

/** A gate decision the route refused, for a caller asserting the refusal. */
export interface RefusedGateDecision { readonly status: number; readonly error: string; readonly code?: string }

/** Posts a gate decision and reports the refusal rather than throwing on it. */
export const attemptGateDecision = async (baseUrl: string, artifactId: ArtifactId, action: string): Promise<RefusedGateDecision> => {
  const gate = await awaitPendingGate(baseUrl, artifactId);
  const response = await fetch(`${baseUrl}/gates/${gate.id}/resume`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ idempotency_key: `${action}:${artifactId}`, artifact_revision_id: artifactId,
      gate_step: gate.gate_step, action, operator_comment: `integration test ${action}` }),
  });
  const parsed = await response.json() as { readonly error?: string; readonly code?: string };
  return { status: response.status, error: parsed.error ?? "", ...(parsed.code ? { code: parsed.code } : {}) };
};

/** What the cohort pull request route made of the evidence. */
export type CohortPullRequestAttempt =
  | { readonly kind: "accepted"; readonly outcome: string }
  | { readonly kind: "refused"; readonly detail: string };

const postCohortEvidence = async (baseUrl: string, cohortId: string, body: unknown): Promise<CohortPullRequestAttempt> => {
  const response = await fetch(`${baseUrl}/cohorts/${encodeURIComponent(cohortId)}/pull_request`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body),
  });
  const text = await response.text();
  if (response.ok) return { kind: "accepted", outcome: (JSON.parse(text) as { outcome: { kind: string } }).outcome.kind };
  if (response.status !== 404 && response.status !== 409) throw new Error(`cohort pull request evidence for ${cohortId} failed: ${response.status} ${text}`);
  return { kind: "refused", detail: `${response.status} ${text}` };
};

/**
 * The operator's fallback: confirm by hand that a cohort's pull request merged.
 *
 * One attempt, no waiting. The handoff only reaches `awaiting_external` once
 * the assessor's decision has travelled to it, and the assessor cannot even
 * start until the caller has driven it — a helper that blocked here would stall
 * the very work it is waiting for.
 *
 * This is the same route the poller uses, and the confirmation is checked
 * against the same expectations as a polled observation. Driving it from a test
 * is not standing in for a missing participant any more: it is the button.
 */
export const confirmCohortMerged = async (baseUrl: string, cohortId: string): Promise<CohortPullRequestAttempt> =>
  postCohortEvidence(baseUrl, cohortId, {
    kind: "operator_confirmation", idempotency_key: `confirm-merged:${cohortId}`, operator_comment: "integration test confirmed the merge",
  });

/** The poller's path: report what the forge said about a cohort's pull request. */
export const observeCohortPullRequest = async (baseUrl: string, cohortId: string, observation: unknown): Promise<CohortPullRequestAttempt> =>
  postCohortEvidence(baseUrl, cohortId, { kind: "observation", observation });

/**
 * What `GithubPullRequestReader` would have produced for a merged cohort pull
 * request, built from the same values the faked agent reported opening.
 */
export const mergedPullRequestObservation = (unitId: UnitId, baseBranch: string) => {
  const url = cohortPullRequestUrl(unitId);
  const number = Number(url.slice(url.lastIndexOf("/") + 1));
  return {
    provider: "github", owner: "RankOneLabs", name: "oakridge", number, url,
    head_branch: cohortHeadBranch(unitId), base_branch: baseBranch, head_sha: "abc123",
    state: "merged", source: "poll", observed_at: new Date().toISOString(), merged_at: new Date().toISOString(),
  };
};

/** An artifact as the operator surface serves it, current revision first. */
export const readArtifact = async (baseUrl: string, artifactId: ArtifactId): Promise<OperatorArtifactDetail> =>
  readJson<OperatorArtifactDetail>(await fetch(`${baseUrl}/artifact_details/${artifactId}`), `read artifact ${artifactId}`);

export const readRun = async (baseUrl: string, runId: OperatorRunSummary["id"]): Promise<OperatorRunDetail> =>
  readJson<OperatorRunDetail>(await fetch(`${baseUrl}/runs/${runId}`), `read run ${runId}`);

export const readReviewInbox = async (baseUrl: string): Promise<OperatorReviewInbox> =>
  readJson<OperatorReviewInbox>(await fetch(`${baseUrl}/review_inbox`), "read review inbox");

/** The gates parked against one run, as `GET /runs/:id/gates` reports them. */
export const listRunGates = async (baseUrl: string, runId: LaunchedRun["run_id"]): Promise<readonly OperatorParkedGate[]> =>
  readJson<readonly OperatorParkedGate[]>(await fetch(`${baseUrl}/runs/${runId}/gates`), `list gates for run ${runId}`);

/**
 * One driven pass of the loop every scenario shares: emit whatever agents
 * owe, decide whichever parked gates the scenario's policy allows, confirm
 * every cohort merge waiting in the review inbox, then check whether the
 * scenario's own condition has been reached.
 */
export interface DriveOptions<Value> {
  /** Decide a parked gate, or leave it open. Called with the gate as `GET /gates` lists it. */
  readonly decide: (gate: OperatorParkedGate) => string | null;
  /** Stop when this returns non-null; it is polled after every pass. */
  readonly until: () => Promise<Value | null>;
  readonly timeout_ms: number;
  readonly confirm_merges?: boolean;
}

export interface DriveOutcome<Value> {
  readonly value: Value;
  /** Execution workflow ids this drive emitted artifacts for and succeeded. */
  readonly driven: ReadonlySet<string>;
  /** Cohort ids (`${stage_instance_id}:${unit_id}`) confirmed merged this drive. */
  readonly confirmed: ReadonlySet<string>;
}

/**
 * Drives a launched run the way every participant but the operator's gate
 * policy really does: emit artifacts, confirm merges, and — the one thing
 * that varies between scenarios — decide only the gates `options.decide`
 * says to.
 *
 * `driven` and `confirmed` accumulate for the lifetime of this call only; a
 * scenario that calls `driveRun` more than once (to vary the gate policy
 * between phases) gets a fresh count each call, exactly as an inline loop
 * restarted with fresh sets would.
 */
export const driveRun = async <Value>(baseUrl: string, agent: ScriptedAgentScenario, run: LaunchedRun, options: DriveOptions<Value>): Promise<DriveOutcome<Value>> => {
  const driven = new Set<string>();
  const confirmed = new Set<string>();
  const decided = new Set<string>();
  const deadline = Date.now() + options.timeout_ms;
  for (;;) {
    for (const [workflowId] of agent.launched) {
      if (driven.has(workflowId)) continue;
      driven.add(workflowId);
    }

    // `listV2PendingGates` reports a collection-key gate's `unit_id` as the
    // collection key itself (spec §3.7), so the gate the API lists is passed
    // to `options.decide` as-is — no re-keying against the emitted artifact.
    for (const gate of await listRunGates(baseUrl, run.run_id)) {
      if (decided.has(gate.id)) continue;
      const requested = options.decide(gate);
      const action = requested === "approve" && gate.resume_actions.includes("confirm_merged") ? "confirm_merged" : requested;
      if (!action) continue;
      if (!gate.artifact_revision_id) continue;
      decided.add(gate.id);
      await decideGate(baseUrl, gate.artifact_revision_id, action);
    }

    if (options.confirm_merges !== false) {
      const inbox = await readReviewInbox(baseUrl);
      for (const item of inbox.items) {
        if (item.kind !== "pull_request_merge" || item.run_id !== run.run_id) continue;
        const cohortId = `${item.stage_instance_id}:${item.unit_id}`;
        expect(item.pr_url).toBe(cohortPullRequestUrl(item.unit_id as UnitId));
        const result = await confirmCohortMerged(baseUrl, cohortId);
        if (result.kind === "accepted" && result.outcome === "completed") confirmed.add(cohortId);
      }
    }

    const value = await options.until();
    if (value !== null) return { value, driven, confirmed };
    if (Date.now() > deadline) {
      const diagnostic = { run: await readRun(baseUrl, run.run_id), gates: await listRunGates(baseUrl, run.run_id),
        inbox: (await readReviewInbox(baseUrl)).items.filter((item) => item.run_id === run.run_id),
        deliveries: agent.deliveries,
        launches: [...agent.launched.entries()].map(([id, launch]) => ({ id, expected: launch.expected_artifacts,
          prompt_tail: String((launch.resolved_config as { readonly rendered_prompt?: string }).rendered_prompt).slice(-700) })) };
      throw new Error(`driveRun timed out after ${options.timeout_ms}ms waiting for run ${run.run_id}'s condition: ${JSON.stringify(diagnostic)}`);
    }
    await Bun.sleep(50);
  }
};

/** `record_version` and how many transitions have been written for one run — invariant 7's measurement. */
export interface RunRecordFingerprint {
  readonly record_version: number;
  readonly transition_count: number;
}

export const readRunRecordFingerprint = async (sql: SqlExecutor, runId: WorkflowRunId): Promise<RunRecordFingerprint> => {
  const runRows = await sql.query<{ readonly record_version: number }>("SELECT record_version FROM oakridge.workflow_run WHERE id = $1", [runId]);
  if (!runRows[0]) throw new Error(`workflow run '${runId}' was not found`);
  const transitionRows = await sql.query<{ readonly count: string }>("SELECT count(*)::text AS count FROM oakridge.run_transition WHERE run_id = $1", [runId]);
  return { record_version: Number(runRows[0].record_version), transition_count: Number(transitionRows[0]?.count ?? 0) };
};

/**
 * Invariant 7 measured: asking again changes nothing. Asks `decide_run`
 * twice — once to prove a quiescent record answers with no work, once more
 * to prove that answer wasn't itself a change — and asserts the fingerprint
 * taken before either ask still matches the one taken after both.
 */
/** How long the record must sit unchanged before the root is taken to be parked: several asks' worth, well under the 5 s recheck. */
export const assertQuietAsk = async (sql: SqlExecutor, runId: WorkflowRunId): Promise<void> => {
  const before = await readRunRecordFingerprint(sql, runId);
  await sendRunWakeHint(runId, `acceptance-quiet-ask-1:${crypto.randomUUID()}`);
  await Bun.sleep(250);
  await sendRunWakeHint(runId, `acceptance-quiet-ask-2:${crypto.randomUUID()}`);
  await Bun.sleep(250);
  expect(await readRunRecordFingerprint(sql, runId)).toEqual(before);
};

interface PromptOutput { readonly output_name: string; readonly unit_id: string }
interface PromptPublication {
  readonly base_url: string;
  readonly work_order_id: string;
  readonly capability: string;
  readonly unit_id: string;
  readonly operator_role: "spec" | "plan" | "brief" | "build" | "assess";
  readonly stage_instance_id: string | null;
  readonly outputs: readonly PromptOutput[];
  readonly head_branch: string | null;
  readonly base_branch: string | null;
}

/** The fake process understands only the contract that the production adapter appends. */
export const parsePromptPublication = (prompt: string): PromptPublication | null => {
  const endpoint = prompt.match(/PUT (https?:\/\/[^\s]+)\/work-orders\/([^/\s]+)\/emit\/<output-name>/);
  const capability = prompt.match(/^Work-Order-Capability: ([^\s]+)$/m)?.[1];
  const outputBlock = prompt.match(/Publish exactly these outputs and no others:\n([\s\S]*?)(?:\n\n|$)/)?.[1];
  if (!endpoint || !capability || !outputBlock) return null;
  const scalarUnit = prompt.match(/(?:Unit\/cohort|Unit): `([^`]+)`/)?.[1]
    ?? prompt.match(/^\s*- ID: (.+)$/m)?.[1]?.trim()
    ?? prompt.match(/"cohort_id"\s*:\s*"([^"]+)"/)?.[1]
    ?? prompt.match(/\*\*ID:\*\* ([^\n]+)/)?.[1]?.trim()
    ?? "0";
  const outputs = [...outputBlock.matchAll(/^- ([^\s]+)(?: \(Output-Collection-Key: ([^)]+)\))?$/gm)]
    .map((match) => ({ output_name: match[1]!, unit_id: match[2] ?? scalarUnit }));
  if (outputs.length === 0) return null;
  const names = new Set(outputs.map((output) => output.output_name));
  const operator_role = names.has("spec_analysis") ? "spec" : names.has("plan") ? "plan" : names.has("brief") ? "brief"
    : names.has("pr_summary") || names.has("build_result") ? "build" : "assess";
  const headBranch = prompt.match(/^Canonical cohort ref: (.+)$/m)?.[1]?.trim() ?? null;
  const baseBranch = prompt.match(/^Pull request base: (.+)$/m)?.[1]?.trim() ?? null;
  const stageInstanceId = prompt.match(/^Stage instance: `([^`]+)`$/m)?.[1]
    ?? headBranch?.match(/^cohort\/([^/]+)\//)?.[1]
    ?? null;
  return { base_url: endpoint[1]!, work_order_id: endpoint[2]!, capability, unit_id: scalarUnit, operator_role, outputs,
    stage_instance_id: stageInstanceId, head_branch: headBranch, base_branch: baseBranch };
};

const runFakeAcpAgent = (): void => {
  const controlUrl = process.env.OAKRIDGE_FAKE_AGENT_CONTROL_URL;
  if (!controlUrl) throw new Error("OAKRIDGE_FAKE_AGENT_CONTROL_URL is required");
  const publications = new Map<string, PromptPublication>();
  const revisions = new Map<string, number>();
  const configOptions = [{ type: "select" as const, id: "model", name: "Model", category: "model" as const,
    currentValue: "opus", options: [{ value: "opus", name: "Opus" }] }];
  const notify = async (client: AgentContext, sessionId: string, text: string): Promise<void> => {
    await client.notify("session/update", { sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } });
  };
  const publishPromptBranch = async (branch: string): Promise<void> => {
    const child = Bun.spawn(["git", "push", "origin", `HEAD:refs/heads/${branch}`], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    if (exitCode !== 0) throw new Error(`fake agent could not publish '${branch}': ${stderr.trim() || stdout.trim()}`);
  };
  const app = agent({ name: "oakridge-acceptance-agent" })
    .onRequest("initialize", () => ({ protocolVersion: PROTOCOL_VERSION, agentCapabilities: { loadSession: true, sessionCapabilities: { close: {} } } }))
    .onRequest("session/new", () => ({ sessionId: crypto.randomUUID(), configOptions }))
    .onRequest("session/load", () => ({ configOptions }))
    .onRequest("session/set_config_option", () => ({ configOptions }))
    .onRequest("session/close", () => ({}))
    .onNotification("session/cancel", () => {})
    .onRequest("session/prompt", async (ctx) => {
      const prompt = ctx.params.prompt.map((block) => block.type === "text" ? block.text : "").join("");
      const scenario = await fetch(`${controlUrl}/scenario`).then((response) => response.json()) as {
        readonly strip_publication_contract?: boolean;
      };
      const renderedPrompt = scenario.strip_publication_contract
        ? prompt.replace(/\n\n## Oakridge v2 artifact publication[\s\S]*$/, "")
        : prompt;
      const parsed = parsePromptPublication(renderedPrompt);
      if (parsed) {
        revisions.set(ctx.params.sessionId, 0);
        const launched = await fetch(`${controlUrl}/launch`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...parsed, prompt: renderedPrompt }) });
        if (!launched.ok) throw new Error(`fake agent launch recording failed: ${launched.status}`);
        const launchIdentity = await launched.json() as { readonly stage_instance_id?: string | null;
          readonly skip_publication?: boolean };
        if (launchIdentity.skip_publication) {
          setTimeout(() => process.exit(0), 10);
          return { stopReason: "end_turn" as const };
        }
        publications.set(ctx.params.sessionId, {
          ...parsed,
          stage_instance_id: launchIdentity.stage_instance_id ?? parsed.stage_instance_id,
        });
      } else {
        await fetch(`${controlUrl}/delivery`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ execution_id: publications.get(ctx.params.sessionId)?.work_order_id ?? ctx.params.sessionId,
            delivery_key: `missing-publication-contract-${Date.now()}`, prompt: renderedPrompt }) });
      }
      const publication = publications.get(ctx.params.sessionId);
      if (!publication) {
        setTimeout(() => process.exit(1), 10);
        throw new Error("rendered prompt did not state the Oakridge publication contract");
      }
      if (publication.head_branch) await publishPromptBranch(publication.head_branch);
      const revision = (revisions.get(ctx.params.sessionId) ?? 0) + 1;
      revisions.set(ctx.params.sessionId, revision);
      for (const output of publication.outputs) {
        const bodyResponse = await fetch(`${controlUrl}/artifact-body`, { method: "POST", headers: { "content-type": "application/json" },
          body: JSON.stringify({ ...publication, ...output, revision }) });
        if (!bodyResponse.ok) throw new Error(`fake artifact body failed: ${bodyResponse.status} ${await bodyResponse.text()}`);
        const response = await fetch(`${publication.base_url}/work-orders/${publication.work_order_id}/emit/${output.output_name}`, {
          method: "PUT", headers: { "content-type": "application/json", "work-order-capability": publication.capability,
            "idempotency-key": `${publication.work_order_id}:${output.unit_id}:${output.output_name}:v${revision}`,
            ...(output.unit_id !== publication.unit_id ? { "output-collection-key": output.unit_id } : {}) },
          body: await bodyResponse.text(),
        });
        if (!response.ok) throw new Error(`fake publication ${output.output_name} failed: ${response.status} ${await response.text()}`);
      }
      await notify(ctx.client, ctx.params.sessionId, `published ${publication.outputs.map((output) => output.output_name).join(", ")}`);
      setTimeout(() => process.exit(0), 10);
      return { stopReason: "end_turn" as const };
    });
  app.connect(ndJsonStream(Writable.toWeb(process.stdout) as WritableStream<Uint8Array>,
    Readable.toWeb(process.stdin) as unknown as ReadableStream<Uint8Array>));
};

if (process.argv.includes("--fake-acp-agent")) runFakeAcpAgent();
