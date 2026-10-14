import { afterAll, beforeAll, expect, test } from "bun:test";
import { DBOS } from "@dbos-inc/dbos-sdk";
import { sql } from "kysely";
import type { EffectInstruction } from "../src/domain/effect-instruction";
import type { EffectProvider, ExternalHandle, ProviderResult, TerminalObservation } from "../src/effects/provider";
import { HANDLE_KINDS } from "../src/effects/provider-catalog";
import { createProductionComposition } from "../src/runtime/compose";
import { intentWorkflowId, wakeRun } from "../src/workflows/topology";
import { launchRunId } from "../src/storage/commit";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";

/** How the scripted provider answers for one run. */
interface Script {
  /** One answer for every start, or each start's answer by its call index. */
  readonly start: ProviderResult<ExternalHandle> | ((call: number) => Promise<ProviderResult<ExternalHandle>>);
  readonly observe: ProviderResult<TerminalObservation>;
  /** Stop answers in order; the last repeats. */
  readonly stops: readonly ProviderResult<{ readonly stopped: true }>[];
}
const session = (session_id: string): ExternalHandle => ({ kind: HANDLE_KINDS.session, session_id });
const STOPPED = { kind: "acknowledged", value: { stopped: true } } as const;
const scripts = new Map<string, Script>();
const stop_calls = new Map<string, (ExternalHandle | null)[]>();
const start_calls = new Map<string, number>();
const runOf = (instruction: EffectInstruction): string => instruction.action.unit.split("/")[0]!;
const scriptOf = (instruction: EffectInstruction): Script => {
  const script = scripts.get(runOf(instruction));
  if (!script) throw new Error(`no script for ${instruction.action.unit}`);
  return script;
};
const provider: EffectProvider = {
  async start(instruction) {
    const call = start_calls.get(runOf(instruction)) ?? 0;
    start_calls.set(runOf(instruction), call + 1);
    const scripted = scriptOf(instruction).start;
    const start = typeof scripted === "function" ? await scripted(call) : scripted;
    return start.kind === "acknowledged" ? { kind: "acknowledged", value: { handle: start.value, publication_secret_hash: "0".repeat(64) } } : start;
  },
  async observe(instruction) { return scriptOf(instruction).observe; },
  async stop(instruction, handle) {
    const calls = stop_calls.get(runOf(instruction)) ?? [];
    stop_calls.set(runOf(instruction), [...calls, handle]);
    const stops = scriptOf(instruction).stops;
    return stops[Math.min(calls.length, stops.length - 1)]!;
  },
};

let scratch: Awaited<ReturnType<typeof scratchDatabase>>;
let db: Database;
let composition: Awaited<ReturnType<typeof createProductionComposition>>;
let digest: string;
const json = (body: unknown): RequestInit => ({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
beforeAll(async () => {
  scratch = await scratchDatabase();
  db = openDatabase(scratch.url);
  await migrateEmptyDatabase(db);
  composition = await createProductionComposition({ database_url: scratch.url, host: "127.0.0.1", effect_provider: provider,
    timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, max_observe_unavailable_attempts: 2, wake_timeout_seconds: 0.5,
      carrier_max_iterations: 3 } });
  ({ digest } = await (await composition.app.request("/api/definitions", json(sampleWorkflow("review-loop")))).json() as { readonly digest: string });
}, 30_000);
afterAll(async () => {
  await composition.close();
  await db.destroy();
  await scratch.drop();
});

async function launchScripted(script: Script, request_id: string = crypto.randomUUID()): Promise<string> {
  scripts.set(launchRunId(request_id), script);
  const launched = await composition.app.request("/api/runs", json({ digest, input: { topic: "Oakridge" }, request_id }));
  return (await launched.json() as { readonly run_id: string }).run_id;
}
const intentsOf = (run_id: string) => db.selectFrom("authority.effect_intent").select(["id", "status", "stop_origin"]).where("run_id", "=", run_id).execute();
const intentOf = (run_id: string) => db.selectFrom("authority.effect_intent").select(["status", "last_error"]).where("run_id", "=", run_id).executeTakeFirstOrThrow();
const attemptOf = (run_id: string) => db.selectFrom("authority.attempt").select("status").where("run_id", "=", run_id).executeTakeFirstOrThrow();
async function until(run_id: string, is_done: (status: string) => boolean, polls = 150): Promise<void> {
  for (let poll = 0; poll < polls && !is_done((await intentOf(run_id)).status); poll++) await Bun.sleep(100);
}
const isSettled = (status: string): boolean => status === "stopped" || status === "failed";

test("an attempt whose observation is refused stops its session, and settles only after the stop is confirmed", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-refused") },
    observe: { kind: "permanently_rejected", code: "session_failed", detail: "observer refused" },
    stops: [{ kind: "transiently_unavailable", detail: "kbbl busy" }, STOPPED] });
  await until(run_id, isSettled);
  expect({ intent: await intentOf(run_id), attempt: (await attemptOf(run_id)).status, stops: stop_calls.get(run_id) }).toEqual({
    intent: { status: "stopped", last_error: "session_failed: observer refused" },
    attempt: { kind: "failed", code: "session_failed", detail: "observer refused" },
    stops: [session("s-refused"), session("s-refused")] });
}, 30_000);

test("a start that never gets a definite answer is stopped without a handle before it settles", async () => {
  const run_id = await launchScripted({ start: { kind: "uncertain", detail: "response lost" },
    observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED] });
  await until(run_id, isSettled);
  const intent = await intentOf(run_id);
  expect({ status: intent.status, last_error: intent.last_error?.split(":")[0], stops: stop_calls.get(run_id) })
    .toEqual({ status: "stopped", last_error: "start_attempts_exhausted", stops: [null] });
}, 30_000);

test("an observation that stays unavailable stops the session rather than failing the intent", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-lost") },
    observe: { kind: "transiently_unavailable", detail: "kbbl down" }, stops: [STOPPED] });
  await until(run_id, isSettled);
  expect({ status: (await intentOf(run_id)).status, stops: stop_calls.get(run_id) }).toEqual({ status: "stopped", stops: [session("s-lost")] });
}, 30_000);

test("a stop the provider keeps refusing leaves the intent owed", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-stuck") },
    observe: { kind: "permanently_rejected", code: "session_failed", detail: "gone" },
    stops: [{ kind: "permanently_rejected", code: "provider_rejected", detail: "no" }] });
  await until(run_id, (status) => status === "stop_requested");
  await Bun.sleep(1_000);
  expect({ status: (await intentOf(run_id)).status, has_retried: (stop_calls.get(run_id)?.length ?? 0) > 1 })
    .toEqual({ status: "stop_requested", has_retried: true });
}, 30_000);

test("cancelling a run with a live session stops it through the cleanup carrier", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-cancel") },
    observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED] });
  await until(run_id, (status) => status === "acknowledged");
  expect((await composition.app.request(`/api/runs/${run_id}/cancel`, json({ request_id: crypto.randomUUID() }))).status).toBe(201);
  await until(run_id, isSettled);
  expect({ status: (await intentOf(run_id)).status, stops: stop_calls.get(run_id) }).toEqual({ status: "stopped", stops: [session("s-cancel")] });
}, 30_000);

test("a carrier re-run after its session started resumes that session rather than starting another", async () => {
  const request_id = crypto.randomUUID();
  // Acknowledging fails past its step retries, so the carrier body runs again with the intent still pending.
  await sql`CREATE SEQUENCE public.ack_faults; CREATE TABLE public.ack_fault_run (run_id text PRIMARY KEY);
    CREATE FUNCTION public.fail_acknowledge() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.status = 'acknowledged' AND OLD.status = 'pending' AND EXISTS (SELECT 1 FROM public.ack_fault_run WHERE run_id = NEW.run_id)
        AND nextval('public.ack_faults') <= 5 THEN RAISE EXCEPTION 'acknowledge refused'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER fail_acknowledge BEFORE UPDATE ON authority.effect_intent FOR EACH ROW EXECUTE FUNCTION public.fail_acknowledge()`.execute(db);
  await sql`INSERT INTO public.ack_fault_run VALUES (${launchRunId(request_id)})`.execute(db);
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-resumed") },
    observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED] }, request_id);
  await until(run_id, (status) => status === "acknowledged", 450);
  const faults = await sql<{ last_value: string }>`SELECT last_value FROM public.ack_faults`.execute(db);
  expect({ status: (await intentOf(run_id)).status, starts: start_calls.get(run_id),
    was_refused_past_retries: Number(faults.rows[0]?.last_value) > 5 })
    .toEqual({ status: "acknowledged", starts: 1, was_refused_past_retries: true });
}, 60_000);

test("an observation that never gets an answer counts toward the bound and stops the session", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-unreachable") },
    observe: { kind: "uncertain", detail: "kbbl unreachable" }, stops: [STOPPED] });
  await until(run_id, isSettled);
  const intent = await intentOf(run_id);
  expect({ status: intent.status, last_error: intent.last_error?.split(":")[0], stops: stop_calls.get(run_id) })
    .toEqual({ status: "stopped", last_error: "observation_unavailable", stops: [session("s-unreachable")] });
}, 30_000);

test("cancelling a run whose start was never claimed settles the stop without reaching kbbl", async () => {
  const request_id = crypto.randomUUID();
  // Every claim of this run's start fails past its step retries, so the intent is still unclaimed when the cancel lands.
  await sql`CREATE TABLE public.claim_fault_run (run_id text PRIMARY KEY);
    CREATE FUNCTION public.fail_claim() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN
      IF NEW.tries > OLD.tries AND EXISTS (SELECT 1 FROM public.claim_fault_run WHERE run_id = NEW.run_id) THEN RAISE EXCEPTION 'claim refused'; END IF;
      RETURN NEW; END $$;
    CREATE TRIGGER fail_claim BEFORE UPDATE ON authority.effect_intent FOR EACH ROW EXECUTE FUNCTION public.fail_claim()`.execute(db);
  await sql`INSERT INTO public.claim_fault_run VALUES (${launchRunId(request_id)})`.execute(db);
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-never") },
    observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED] }, request_id);
  expect((await composition.app.request(`/api/runs/${run_id}/cancel`, json({ request_id: crypto.randomUUID() }))).status).toBe(201);
  await until(run_id, isSettled);
  expect({ status: (await intentOf(run_id)).status, attempt: (await attemptOf(run_id)).status, starts: start_calls.get(run_id), stops: stop_calls.get(run_id) })
    .toEqual({ status: "stopped", attempt: { kind: "failed", code: "attempt_stopped", detail: "stopped because its unit is no longer active" },
      starts: undefined, stops: undefined });
}, 30_000);

test("a stop commit requested after a failed start try still ends the attempt as stopped", async () => {
  let release_start = (): void => undefined;
  const held_start = new Promise<void>((resolve) => { release_start = resolve; });
  const run_id = await launchScripted({ observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED],
    // The first try fails and records its error; the second is held open until the stop has settled.
    start: async (call) => {
      if (call === 0) return { kind: "transiently_unavailable", detail: "kbbl busy" };
      await held_start;
      return { kind: "acknowledged", value: session("s-late") };
    } });
  for (let poll = 0; poll < 150 && (start_calls.get(run_id) ?? 0) < 2; poll++) await Bun.sleep(100);
  try {
    expect((await composition.app.request(`/api/runs/${run_id}/cancel`, json({ request_id: crypto.randomUUID() }))).status).toBe(201);
    await until(run_id, isSettled);
    expect({ intent: await intentOf(run_id), origin: (await intentsOf(run_id))[0]?.stop_origin, attempt: (await attemptOf(run_id)).status })
      .toEqual({ intent: { status: "stopped", last_error: "kbbl busy" }, origin: "commit",
        attempt: { kind: "failed", code: "attempt_stopped", detail: "stopped because its unit is no longer active" } });
  } finally { release_start(); }
}, 30_000);

test("an agent carrier observing past its iteration bound hands its intent to the next generation", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-long") },
    observe: { kind: "acknowledged", value: { kind: "running" } }, stops: [STOPPED] });
  await until(run_id, (status) => status === "acknowledged");
  const intent_id = (await intentsOf(run_id))[0]!.id;
  const carriers = () => DBOS.listWorkflows({ workflowName: "oakridgeEffectWorkflow", workflow_id_prefix: intentWorkflowId(intent_id) });
  for (let poll = 0; poll < 150 && (await carriers()).length < 3; poll++) await Bun.sleep(100);
  const first = await DBOS.getWorkflowStatus(intentWorkflowId(intent_id));
  expect({ has_successors: (await carriers()).length >= 3, first: first?.status, status: (await intentOf(run_id)).status, starts: start_calls.get(run_id) })
    .toEqual({ has_successors: true, first: "SUCCESS", status: "acknowledged", starts: 1 });
  expect((await composition.app.request(`/api/runs/${run_id}/cancel`, json({ request_id: crypto.randomUUID() }))).status).toBe(201);
  await until(run_id, isSettled);
  expect(stop_calls.get(run_id)).toEqual([session("s-long")]);
}, 30_000);

test("a start carrier that finished while its intent is still owed ends the attempt rather than failing the run workflow", async () => {
  const run_id = await launchScripted({ start: { kind: "acknowledged", value: session("s-orphan") },
    observe: { kind: "acknowledged", value: { kind: "terminal", result: { kind: "succeeded" } } }, stops: [STOPPED] });
  let finished: string | null = null;
  for (let poll = 0; poll < 150 && finished === null; poll++) {
    await Bun.sleep(100);
    for (const intent of await intentsOf(run_id))
      if (intent.status === "stopped" && (await DBOS.getWorkflowStatus(intentWorkflowId(intent.id)))?.status === "SUCCESS") finished = intent.id;
  }
  if (finished === null) throw new Error("no start carrier finished");
  const orphan = finished;
  // A carrier that returns with its intent owed: no body will carry it again.
  await db.updateTable("authority.effect_intent").set({ status: "acknowledged" }).where("id", "=", orphan).execute();
  await wakeRun(run_id);
  const statusOf = async () => (await db.selectFrom("authority.effect_intent").select("status").where("id", "=", orphan).executeTakeFirstOrThrow()).status;
  for (let poll = 0; poll < 150 && await statusOf() !== "stopped"; poll++) await Bun.sleep(100);
  const workflows = await DBOS.listWorkflows({ workflowName: "oakridgeRunWorkflow", workflow_id_prefix: `run:${run_id}` });
  expect({ status: await statusOf(), origin: (await intentsOf(run_id)).find((intent) => intent.id === orphan)?.stop_origin,
    run_errors: workflows.filter((workflow) => workflow.status === "ERROR").length, stopped: stop_calls.get(run_id)?.some((handle) => handle?.session_id === "s-orphan") ?? false })
    .toEqual({ status: "stopped", origin: "executor", run_errors: 0, stopped: true });
}, 30_000);
