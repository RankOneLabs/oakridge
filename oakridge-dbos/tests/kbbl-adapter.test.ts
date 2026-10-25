import { expect, test } from "bun:test";
import type { RunConfig } from "../src/domain/run-config";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { KbblClient, REVIVE_HEADER } from "../src/adapters/kbbl";
import type { ResolvedRunWorker } from "../src/core-client/core-types";
import { selectEffectInstruction, type EffectInstruction, type RunWorkerAction } from "../src/domain/effect-instruction";
import { createAgentProvider, derivePublicationSecret, publicationSecretHash, selectDeliveryKey, selectSessionStart, selectWorkspaceBranch, type AgentProviderConfig } from "../src/effects/agent-provider";
import type { ExternalHandle } from "../src/effects/provider";
import { resolveObserve } from "../src/effects/outcomes";
import { sampleWorkflow } from "./authority-fixture";

interface Call { readonly method: string; readonly url: string; readonly headers: Headers; readonly body: unknown }
/** A fetch that records each call and answers from `respond`. */
function recording(respond: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  const fetch = async (input: string | URL | Request, init: RequestInit = {}): Promise<Response> => {
    const call = { method: init.method ?? "GET", url: String(input), headers: new Headers(init.headers),
      body: typeof init.body === "string" ? JSON.parse(init.body) : null };
    calls.push(call);
    return respond(call);
  };
  return { calls, fetch };
}
const snapshot = (status = "live", extra: object = {}) => ({ sid: "sid-1", status, lastActivityTs: "2026-10-12T12:00:00.000Z", ...extra });

const run_id = "run-1" as import("../src/domain/primitives").RunId;
const unit = "run-1/document";
const writer: RunWorkerAction = { kind: "run_worker", unit, worker: "writer", mode: { kind: "initial" }, cause: { kind: "missing" } };
function instructionFor(overrides: { readonly action?: RunWorkerAction; readonly resolved?: Partial<ResolvedRunWorker>; readonly fresh?: boolean;
  readonly config?: RunConfig } = {}): EffectInstruction {
  const workflow = sampleWorkflow("review-loop");
  const declared = workflow.stages.document!.workers.writer!;
  const fresh = overrides.fresh && declared.kind === "agent"
    ? { ...workflow, stages: { document: { ...workflow.stages.document!, workers: { ...workflow.stages.document!.workers, writer: { ...declared, session: "fresh" as const } } } } }
    : workflow;
  const action = overrides.action ?? writer;
  const selected = selectEffectInstruction({ run_id, workflow: fresh, stage: "document", config: overrides.config ?? null, action, seq: 0,
    prompts: { "review-loop/write.md": "a".repeat(64), "review-loop/revise.md": "b".repeat(64) },
    resolved: { action_id: `action-${action.mode.kind}`, inputs: { topic: "Oakridge", critique: null }, ...overrides.resolved } });
  if (!selected.ok) throw new Error(selected.error.detail);
  return selected.value;
}
const config = (fetch: ReturnType<typeof recording>["fetch"], overrides: Partial<AgentProviderConfig> = {}): AgentProviderConfig => ({
  kbbl: new KbblClient({ base_url: "http://kbbl.test/", fetch }), publication_key: "key", publish_base_url: "http://oakridge.test",
  default_workdir: "/srv/agents", ...overrides });
const session: ExternalHandle = { kind: "kbbl_session", session_id: "sid-1" };
function sessionKeyOf(instruction: EffectInstruction): string {
  if (instruction.worker.kind !== "agent") throw new Error("not an agent instruction");
  return instruction.worker.session_key;
}

// ------------------------------------------------------------- client -------

test("ensure asks kbbl to revive an ended session under the key", async () => {
  const { calls, fetch } = recording(() => Response.json({ kind: "attached", session: snapshot() }));
  const ensured = await new KbblClient({ base_url: "http://kbbl.test", fetch }).ensure("a.b", { initial_prompt: "p", workdir: "/w" }, { should_revive: true });
  expect({ ensured, url: calls[0]!.url, revive: calls[0]!.headers.get(REVIVE_HEADER) }).toEqual({
    ensured: { kind: "acknowledged", value: { kind: "attached", session: { sid: "sid-1", status: "live", last_activity_ts: "2026-10-12T12:00:00.000Z" } } },
    url: "http://kbbl.test/sessions/resumable/a.b", revive: "true" });
});

// kbbl refuses an unauthenticated write once it has a control token, so the executor presents one on every call.
test("a configured control token reaches kbbl as Bearer on every call", async () => {
  const { calls, fetch } = recording(() => Response.json({ kind: "attached", session: snapshot() }));
  const client = new KbblClient({ base_url: "http://kbbl.test", control_token: "kbbl-token", fetch });
  await client.ensure("a.b", { initial_prompt: "p", workdir: "/w" }, { should_revive: true });
  await client.deliver("sid-1", "k", "do it");
  await client.read("sid-1");
  await client.close("sid-1", { action_id: "a", is_fence: false });
  expect(calls.map((call) => [call.method, call.headers.get("authorization")])).toEqual([["PUT", "Bearer kbbl-token"], ["PUT", "Bearer kbbl-token"],
    ["GET", "Bearer kbbl-token"], ["DELETE", "Bearer kbbl-token"]]);
});

test("a 5xx answer is transient, a 4xx refusal permanent, and a lost connection uncertain", async () => {
  const answers = [new Response("busy", { status: 503 }), new Response("bad", { status: 400 })];
  const client = new KbblClient({ base_url: "http://kbbl.test", fetch: async () => {
    const answer = answers.shift();
    if (!answer) throw new Error("connection reset");
    return answer;
  } });
  const kinds = [];
  for (let call = 0; call < 3; call++) kinds.push((await client.ensure("key", { initial_prompt: "p", workdir: "/w" }, { should_revive: true })).kind);
  expect(kinds).toEqual(["transiently_unavailable", "permanently_rejected", "uncertain"]);
});

test("a delivered input's receipt reports its turn", async () => {
  const { calls, fetch } = recording(() => Response.json({ accepted: true, delivery_key: "k", status: "prompting" }));
  const receipt = await new KbblClient({ base_url: "http://kbbl.test", fetch }).deliver("sid-1", "action-1", "do it");
  expect({ receipt, url: calls[0]!.url, body: calls[0]!.body }).toEqual({ receipt: { kind: "acknowledged", value: { status: "prompting" } },
    url: "http://kbbl.test/sessions/resumable/sid-1/input/action-1", body: { text: "do it" } });
});

test("a shared worker receives its own bearer token and unit endpoint with every task", async () => {
  const base = instructionFor();
  if (base.worker.kind !== "agent") throw new Error("writer is an agent");
  const shared: EffectInstruction = { ...base, action: { ...base.action, unit: "run-1/briefs/a" },
    worker: { ...base.worker, session: "shared", session_key: "shared-key", shared_session_unit: "run-1/briefs" } };
  const { calls, fetch } = recording(() => Response.json({ accepted: true, status: "prompting" }));
  await createAgentProvider(config(fetch)).observe(shared, { task: "write this brief" }, session);
  const delivered = (calls[0]?.body as { readonly text: string } | undefined)?.text ?? "";
  expect([delivered.includes(`Authorization: Bearer ${derivePublicationSecret("key", "shared-key")}`),
    delivered.includes("PUT http://oakridge.test/api/runs/run-1/units/run-1%2Fbriefs%2Fa/artifacts/draft"),
    delivered.endsWith("write this brief")]).toEqual([true, true, true]);
});

test("a session reading names how it ended: closed, failed with kbbl's code, or succeeded", async () => {
  const bodies = [
    Response.json({ session: snapshot("ended"), end: { kind: "closed" } }),
    Response.json({ session: snapshot("ended"), end: { kind: "failed", code: "requested_model_unsupported", detail: "no such model" } }),
    Response.json({ session: snapshot(), end: { kind: "succeeded" } }),
    Response.json({ pending: true, session: snapshot() }, { status: 202 }),
  ];
  const client = new KbblClient({ base_url: "http://kbbl.test", fetch: async () => bodies.shift()! });
  const ends = [];
  for (let call = 0; call < 4; call++) {
    const reading = await client.read("sid-1");
    ends.push(reading.kind === "acknowledged" ? reading.value.kind === "ended" ? reading.value.end : "pending" : reading.kind);
  }
  expect(ends).toEqual([{ kind: "closed" }, { kind: "failed", code: "requested_model_unsupported", detail: "no such model" }, { kind: "succeeded" }, "pending"]);
});

test("a close names its attempt, fencing only when asked, and an unknown session is already stopped", async () => {
  const { calls, fetch } = recording((call) => new Response(null, { status: call.url.includes("gone") ? 404 : 200 }));
  const client = new KbblClient({ base_url: "http://kbbl.test", fetch });
  const results = [await client.close("sid-1", { action_id: "action-1", is_fence: true }),
    await client.close("sid-1", { action_id: "action-2", is_fence: false }), await client.close("gone", { action_id: "action-3", is_fence: false })];
  expect({ kinds: results.map((result) => result.kind), urls: calls.map((call) => call.url) }).toEqual({
    kinds: ["acknowledged", "acknowledged", "acknowledged"],
    urls: ["http://kbbl.test/sessions/sid-1?fenced_by=action-1", "http://kbbl.test/sessions/sid-1?closed_by=action-2",
      "http://kbbl.test/sessions/gone?closed_by=action-3"] });
});

// ---------------------------------------------------------- provider -------

test("without kbbl an agent start is refused with a typed code, and a stop stays owed rather than claimed", async () => {
  const provider = createAgentProvider({ kbbl: null, publication_key: null, publish_base_url: "", default_workdir: "/" });
  const started = await provider.start(instructionFor());
  expect([started.kind === "permanently_rejected" ? started.code : started.kind, (await provider.stop(instructionFor(), session)).kind])
    .toEqual(["kbbl_unconfigured", "transiently_unavailable"]);
});

test("a delivery key is fixed-length however long the action id", () => {
  const long = instructionFor({ resolved: { action_id: `run-1/${"k".repeat(400)}:writer:Initial:Missing` } });
  expect([selectDeliveryKey(long).length, selectDeliveryKey(instructionFor()) === selectDeliveryKey(long)]).toEqual([64, false]);
});

test("a failed activity read counts toward unavailability instead of reading as running", async () => {
  const { fetch } = recording((call) => call.method === "GET" ? new Response("down", { status: 503 })
    : Response.json({ accepted: true, status: "prompting" }));
  const observed = await createAgentProvider(config(fetch)).observe(instructionFor(), { task: "t" }, session);
  expect(observed.kind).toBe("transiently_unavailable");
});

test("every ensure of a session sends the same spec, carrying the session's secret and its hash on the attempt", async () => {
  const { calls, fetch } = recording(() => Response.json({ kind: "started", session: snapshot("starting") }, { status: 201 }));
  const provider = createAgentProvider(config(fetch));
  const first = await provider.start(instructionFor());
  const revise = await provider.start(instructionFor({ action: { ...writer, mode: { kind: "revise" }, cause: { kind: "changes_requested", decision: "d1" } } }));
  const secret = derivePublicationSecret("key", sessionKeyOf(instructionFor()));
  expect({ same_key: calls[0]!.url === calls[1]!.url, same_spec: JSON.stringify(calls[0]!.body) === JSON.stringify(calls[1]!.body),
    hashes: [first, revise].map((result) => result.kind === "acknowledged" ? result.value.publication_secret_hash : null),
    carries_secret: (calls[0]!.body as { initial_prompt: string }).initial_prompt.includes(secret) })
    .toEqual({ same_key: true, same_spec: true, hashes: [publicationSecretHash(secret), publicationSecretHash(secret)], carries_secret: true });
  expect(publicationSecretHash(secret)).toBe(createHash("sha256").update(secret).digest("hex"));
});

test("sibling briefs ensure the same shared session start spec", () => {
  const first = instructionFor({ action: { ...writer, unit: "run-1/briefs/a" } });
  const second = instructionFor({ action: { ...writer, unit: "run-1/briefs/b" } });
  if (first.worker.kind !== "agent" || second.worker.kind !== "agent") throw new Error("writer is an agent");
  const shared_worker = { ...first.worker, session: "shared" as const, shared_session_unit: "run-1/briefs", session_key: "shared-key" };
  const a: EffectInstruction = { ...first, worker: shared_worker };
  const b: EffectInstruction = { ...second, worker: { ...second.worker, ...shared_worker } };
  const options = { publish_base_url: "http://oakridge.test", default_workdir: "/srv/agents" };
  expect(selectSessionStart(a, options, "secret")).toEqual(selectSessionStart(b, options, "secret"));
});

test("a repository workspace runs in a worktree branched from origin's base branch; none runs in the agent workdir", () => {
  const plain = selectSessionStart(instructionFor(), { publish_base_url: "http://oakridge.test", default_workdir: "/srv/agents" }, "s");
  const repo = selectSessionStart(instructionFor({ resolved: { workspace: { repository_path: "/srv/repo", push_remote_owner: "o", head: "abc123",
    base_branch: "epic/tiers" } } }),
    { publish_base_url: "http://oakridge.test", default_workdir: "/srv/agents" }, "s");
  expect({ plain: [plain.workdir, plain.worktree ?? null], repo: [repo.workdir, repo.worktree?.base_ref, repo.worktree?.branch_name.startsWith("oakridge/")] })
    .toEqual({ plain: ["/srv/agents", null], repo: ["/srv/repo", "origin/epic/tiers", true] });
});

test("development cohort worktrees use the cohort key and a stable six-character session hash", () => {
  const action = { ...writer, unit: "run-1/implementation/dark_theme_palette" };
  const cohort = instructionFor({ action, resolved: { workspace: { repository_path: "/srv/repo", head: "abc123", base_branch: "epic/tiers" } } });
  const revision = instructionFor({ action: { ...action, mode: { kind: "revise" }, cause: { kind: "changes_requested", decision: "d1" } } });
  const branch = selectWorkspaceBranch(cohort);
  const start = selectSessionStart(cohort, { publish_base_url: "http://oakridge.test", default_workdir: "/srv/agents" }, "s");
  expect({ branch, start_branch: start.worktree?.branch_name, same_on_revision: selectWorkspaceBranch(revision) === branch,
    unrelated_stage: selectWorkspaceBranch(instructionFor()).startsWith("oakridge/") })
    .toEqual({ branch: expect.stringMatching(/^cohort\/dark_theme_palette\/[0-9a-f]{6}$/), start_branch: branch, same_on_revision: true,
      unrelated_stage: true });
});

test("a session starts with the runtime, model and effort chosen for its worker", () => {
  const start = selectSessionStart(instructionFor({ config: { sessions: { document: { writer: { harness: "codex", model: "gpt-6-sol", effort: "high" } } } } }),
    { publish_base_url: "http://oakridge.test", default_workdir: "/srv/agents" }, "s");
  expect([start.runtime, start.model, start.effort]).toEqual(["codex", "gpt-6-sol", "high"]);
});

test("observing delivers the task under the action's key and reads its turn", async () => {
  const statuses = ["accepted", "succeeded", "failed"];
  const { calls, fetch } = recording((call) => call.method === "GET"
    ? Response.json({ session: snapshot(), end: { kind: "succeeded" } })
    : Response.json({ accepted: true, status: statuses.shift() }));
  const provider = createAgentProvider(config(fetch, { now: () => Date.parse("2026-10-12T12:00:01.000Z") }));
  const results = [];
  for (let poll = 0; poll < 3; poll++) results.push(await provider.observe(instructionFor(), { task: "write it" }, session));
  expect({ results: results.map((result) => result.kind === "acknowledged" ? result.value : result.kind),
    delivered: calls.filter((call) => call.method === "PUT").map((call) => [call.url, call.body]) }).toEqual({
    results: [{ kind: "running" }, { kind: "terminal", result: { kind: "succeeded" } },
      { kind: "terminal", result: { kind: "failed", code: "session_failed", detail: "the task's turn in kbbl session sid-1 ended failed" } }],
    delivered: Array.from({ length: 3 }, () => [`http://kbbl.test/sessions/resumable/sid-1/input/${selectDeliveryKey(instructionFor())}`, { text: "write it" }]) });
});

test("a session closed under a running task fails the attempt as closed", async () => {
  const { fetch } = recording((call) => call.method === "GET"
    ? Response.json({ session: snapshot("ended"), end: { kind: "closed" } })
    : Response.json({ error: "session is ended", code: "session_not_found" }, { status: 404 }));
  const observed = await createAgentProvider(config(fetch)).observe(instructionFor(), { task: "t" }, session);
  expect(observed.kind === "acknowledged" && observed.value.kind === "terminal" && observed.value.result.kind === "failed" ? observed.value.result.code : null)
    .toBe("session_closed");
});

// A silent session may still be running: the observation is refused, so the carrier stops the session instead of settling past it.
test("a task silent past the bound refuses its observation as executor_silent_timeout", async () => {
  const { fetch } = recording((call) => call.method === "GET"
    ? Response.json({ pending: true, session: snapshot() }, { status: 202 })
    : Response.json({ accepted: true, status: "prompting" }));
  const provider = createAgentProvider(config(fetch, { max_silent_ms: 60_000, now: () => Date.parse("2026-10-12T12:05:00.000Z") }));
  const observed = await provider.observe(instructionFor(), { task: "t" }, session);
  expect(resolveObserve(observed)).toMatchObject({ kind: "refused", failure: { code: "executor_silent_timeout" } });
});

test("a stop fences a fresh session, closes a resumed one revivably as its attempt, and finds a lost start by its ensure", async () => {
  const { calls, fetch } = recording((call) => call.method === "PUT"
    ? Response.json({ kind: "attached", session: snapshot() }) : new Response(null, { status: 200 }));
  const provider = createAgentProvider(config(fetch));
  await provider.stop(instructionFor({ fresh: true }), session);
  await provider.stop(instructionFor(), session);
  await provider.stop(instructionFor(), null);
  expect(calls.map((call) => `${call.method} ${call.url}`)).toEqual([
    "DELETE http://kbbl.test/sessions/sid-1?fenced_by=action-initial",
    "DELETE http://kbbl.test/sessions/sid-1?closed_by=action-initial",
    `PUT http://kbbl.test/sessions/resumable/${sessionKeyOf(instructionFor())}`,
    "DELETE http://kbbl.test/sessions/sid-1?closed_by=action-initial",
  ]);
});

// A stop must not revive an ended session only to close it, nor have kbbl replace one that never provisioned.
test("a start revives the session under its key, and a stop looks a lost start up without reviving it", async () => {
  const { calls, fetch } = recording((call) => call.method === "PUT"
    ? Response.json({ kind: "attached", session: snapshot() }) : new Response(null, { status: 200 }));
  const provider = createAgentProvider(config(fetch));
  await provider.start(instructionFor());
  await provider.stop(instructionFor(), null);
  expect(calls.filter((call) => call.method === "PUT").map((call) => call.headers.get(REVIVE_HEADER))).toEqual(["true", null]);
});

/** The routes kbbl registers, from its handlers, as method and path patterns. */
function kbblRoutes(): readonly { readonly method: string; readonly pattern: RegExp }[] {
  const root = resolve(import.meta.dir, "../../kbbl/core/server/handlers");
  return ["sessions.ts", "acp-per-sid.ts"].flatMap((file) => [...readFileSync(resolve(root, file), "utf8")
    .matchAll(/app\.(get|put|post|delete)\("([^"]+)"/g)]
    .map(([, method, path]) => ({ method: method!.toUpperCase(), pattern: new RegExp(`^${path!.replace(/:[A-Za-z]+/g, "[^/]+")}$`) })));
}

test("an agent's start, revise, observation and stops call only routes kbbl registers", async () => {
  const { calls, fetch } = recording((call) => call.method === "PUT" && !call.url.includes("/input/")
    ? Response.json({ kind: "attached", session: snapshot() })
    : call.method === "GET" ? Response.json({ pending: true, session: snapshot() }, { status: 202 })
    : call.method === "DELETE" ? new Response(null, { status: 200 }) : Response.json({ accepted: true, status: "prompting" }));
  const provider = createAgentProvider(config(fetch, { now: () => Date.parse("2026-10-12T12:00:01.000Z") }));
  const revise = instructionFor({ action: { ...writer, mode: { kind: "revise" }, cause: { kind: "changes_requested", decision: "d1" } } });
  await provider.start(instructionFor());
  await provider.observe(instructionFor(), { task: "write" }, session);
  await provider.start(revise);
  await provider.observe(revise, { task: "revise" }, session);
  await provider.stop(revise, session);
  await provider.stop(instructionFor({ fresh: true }), null);
  const routes = kbblRoutes();
  const unregistered = calls.map((call) => `${call.method} ${new URL(call.url).pathname}`)
    .filter((call) => !routes.some((route) => call.startsWith(`${route.method} `) && route.pattern.test(call.slice(call.indexOf(" ") + 1))));
  expect({ calls: calls.length > 6, unregistered }).toEqual({ calls: true, unregistered: [] });
});
