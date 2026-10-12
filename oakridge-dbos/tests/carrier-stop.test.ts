import { afterAll, beforeAll, expect, test } from "bun:test";
import type { EffectInstruction } from "../src/domain/effect-instruction";
import type { EffectProvider, ExternalHandle, ProviderResult, TerminalObservation } from "../src/effects/provider";
import { INPUT_CONTRACTS } from "../src/effects/provider-catalog";
import { createProductionComposition } from "../src/runtime/compose";
import { launchRunId } from "../src/storage/commit";
import { openDatabase, type Database } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { sampleWorkflow, scratchDatabase } from "./authority-fixture";

/** How the scripted provider answers for one run. */
interface Script {
  readonly start: ProviderResult<ExternalHandle>;
  readonly observe: ProviderResult<TerminalObservation>;
  /** Stop answers in order; the last repeats. */
  readonly stops: readonly ProviderResult<{ readonly stopped: true }>[];
}
const session = (session_id: string): ExternalHandle => ({ kind: INPUT_CONTRACTS.session, session_id });
const STOPPED = { kind: "acknowledged", value: { stopped: true } } as const;
const scripts = new Map<string, Script>();
const stop_calls = new Map<string, (ExternalHandle | null)[]>();
const runOf = (instruction: EffectInstruction): string => instruction.action.unit.split("/")[0]!;
const scriptOf = (instruction: EffectInstruction): Script => {
  const script = scripts.get(runOf(instruction));
  if (!script) throw new Error(`no script for ${instruction.action.unit}`);
  return script;
};
const provider: EffectProvider = {
  async start(instruction) { return scriptOf(instruction).start; },
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
    timing: { retry_initial_seconds: 0.05, retry_cap_seconds: 0.2, observe_interval_seconds: 0.05, max_observe_unavailable_attempts: 2, wake_timeout_seconds: 0.5 } });
  ({ digest } = await (await composition.app.request("/api/definitions", json(sampleWorkflow("review-loop")))).json() as { readonly digest: string });
}, 30_000);
afterAll(async () => {
  await composition.close();
  await db.destroy();
  await scratch.drop();
});

async function launchScripted(script: Script): Promise<string> {
  const request_id = crypto.randomUUID();
  scripts.set(launchRunId(request_id), script);
  const launched = await composition.app.request("/api/runs", json({ digest, input: { topic: "Oakridge" }, request_id }));
  return (await launched.json() as { readonly run_id: string }).run_id;
}
const intentOf = (run_id: string) => db.selectFrom("authority.effect_intent").select(["status", "last_error"]).where("run_id", "=", run_id).executeTakeFirstOrThrow();
const attemptOf = (run_id: string) => db.selectFrom("authority.attempt").select("status").where("run_id", "=", run_id).executeTakeFirstOrThrow();
async function until(run_id: string, is_done: (status: string) => boolean): Promise<void> {
  for (let poll = 0; poll < 150 && !is_done((await intentOf(run_id)).status); poll++) await Bun.sleep(100);
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
