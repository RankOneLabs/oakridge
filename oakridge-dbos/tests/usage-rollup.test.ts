import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import type { ActionId } from "../src/domain/primitives";
import type { KbblUsage, UsageTurn, UsageReading } from "../src/domain/usage";
import type { RunRead } from "../src/storage/read-store";
import { selectDeliveryKey } from "../src/effects/agent-provider";
import { attributeUsage, type AttributionAttempt } from "../src/projections/usage-attribution";
import { costDeltas, sumUsage, tokensFor } from "../src/projections/usage-cost";
import { classifyRework } from "../src/projections/usage-rework";
import { turnDuration } from "../src/projections/usage-time";
import { readUsageView } from "../src/http/read-models";
import { KbblClient } from "../src/adapters/kbbl";
import { readObservationCost } from "../src/adapters/observation";
const date = (seconds: number) => new Date(seconds*1000).toISOString();
const attempt = (seq: number): AttributionAttempt => ({ action_id: "action" as ActionId, seq, kbbl_session_id: "sid", created_at: new Date(seq*1000) });
const turn = (key: string, seconds: number): UsageTurn => ({ turn_key: key, source: "collaboration", status: "succeeded", created_at: date(seconds), started_at: date(seconds+1), completed_at: date(seconds+3), usage: null });
const reading = (seq: number, amount: number, process_seq = 0): UsageReading => ({ seq, cost_amount: amount, process_seq, cost_currency: "USD", context_used: null, context_size: null, active_turn_key: null, autonomous: false, origin_kind: null, received_at: date(100) });
const session = (turns: UsageTurn[], readings: UsageReading[] = []): KbblUsage => ({ sid: "sid", turns, readings });
test("delivery hash retains its original encoding", () => expect(selectDeliveryKey(attempt(1))).toBe(createHash("sha256").update("action\u00001").digest("hex")));
test("resumed and shared turns follow delivered start times regardless of source", () => {
 const a = attempt(1), b = { ...attempt(2), action_id: "another-unit" as ActionId };
 const preamble = { ...turn("initial:key",0), source: "initial" as const };
 const owned = attributeUsage([b,a], [session([preamble, turn(selectDeliveryKey(a),2), turn("operator-before",5), turn(selectDeliveryKey(b),10), turn("operator-after",14)])]);
 expect(owned.map((o) => [o.attempt?.action_id, o.kind, o.turn.source])).toEqual([[a.action_id,"incidental","initial"],[a.action_id,"delivered","collaboration"],[a.action_id,"incidental","collaboration"],[b.action_id,"delivered","collaboration"],[b.action_id,"incidental","collaboration"]]);
});
test("sessions without attempts retain unattributed turns", () => expect(attributeUsage([], [session([turn("x",0)])])[0]?.attempt).toBeNull());
test("cost deltas restart with the process and on a counter decrease", () => expect(costDeltas([session([], [reading(0,.1),reading(1,.25),reading(2,.05,1),reading(3,.01,1)])], []).map((d) => d.usd)).toEqual([.1,.15,.05,.01]));
test("autonomous and idle deltas use the most recent turn as background", () => {
 const turns = attributeUsage([attempt(1)], [session([turn("x",0)])]);
 const deltas = costDeltas([session([], [reading(0,.1),{ ...reading(1,.2), autonomous: true, active_turn_key: "missing" }])], turns);
 expect(deltas.map((d) => [d.owner?.turn.turn_key,d.background])).toEqual([["x",true],["x",true]]);
});
test("absent token sums remain null", () => expect(sumUsage([{ tokens: tokensFor(turn("x",0)), usd: null, agent_ms: null }]).tokens.total).toBeNull());
test("turn time records agent work and queue separately", () => expect(turnDuration(turn("x",0))).toEqual({ agent_ms: 2000, queue_ms: 1000 }));
test("agent time sums turns into attempts, unit splits and the run across parallel units", async () => {
 const { selectRunUsage } = await import("../src/projections/usage-view");
 const first = attempt(1), retry = attempt(2);
 const parallel = { ...attempt(1), action_id: "parallel" as ActionId, kbbl_session_id: "parallel-sid" };
 const read = { run: { id: "run", created_at: new Date(0) },
  attempts: [
   { ...first, unit_id: "unit", worker: "builder", cause: { kind: "missing" } },
   { ...retry, unit_id: "unit", worker: "builder", cause: { kind: "retry" } },
   { ...parallel, unit_id: "parallel-unit", worker: "builder", cause: { kind: "missing" } },
  ],
  units: [{ id: "unit", stage: "implementation", collection_key: "first" }, { id: "parallel-unit", stage: "implementation", collection_key: "second" }],
  revisions: [], decisions: [], definition: { parsed_workflow: { stages: {} } },
 } as unknown as RunRead;
 const usage = selectRunUsage(read, [
  session([
   turn(selectDeliveryKey(first), 0),
   { ...turn("steering", 3), completed_at: date(8) },
   { ...turn(selectDeliveryKey(retry), 9), completed_at: date(13) },
  ]),
  { ...session([
   { ...turn(selectDeliveryKey(parallel), 0), completed_at: date(6) },
   { ...turn("parallel-steering", 6), completed_at: date(8) },
  ]), sid: parallel.kbbl_session_id },
 ], [], null);
 expect({
  units: usage.units.map((unit) => ({
   attempts: unit.attempts.map((entry) => ({ turns: entry.turns.map((entry) => entry.agent_ms), agent_ms: entry.agent_ms })),
   first_pass_ms: unit.first_pass.agent_ms, rework_ms: unit.rework.agent_ms,
  })),
  run_ms: usage.totals.agent_ms, rework_ms: usage.rework.agent_ms,
 }).toEqual({
  units: [
   { attempts: [{ turns: [2000, 4000], agent_ms: 6000 }, { turns: [3000], agent_ms: 3000 }], first_pass_ms: 6000, rework_ms: 3000 },
   { attempts: [{ turns: [5000, 1000], agent_ms: 6000 }], first_pass_ms: 6000, rework_ms: null },
  ],
  run_ms: 15000, rework_ms: 3000,
 });
});
test("rework propagates through revision publishing attempts", () => {
 const first = { ...attempt(1), cause: { kind: "missing" as const } };
 const retry = { ...attempt(2), cause: { kind: "changes_requested" as const, decision: "no" } };
 const review = { ...attempt(3), cause: { kind: "review_of" as const, revision: "rev" } };
 expect([...classifyRework([review,retry,first], [{ id: "rev" as never, by_id: first.action_id, created_at: new Date(2500) }])]).toEqual(["action:2","action:3"]);
});
test("kbbl usage transport refusals and network errors are values", async () => {
 for (const fetcher of [async () => new Response("bad", { status: 500 }), async (): Promise<Response> => { throw new Error("offline"); }]) {
  const client = new KbblClient({ base_url: "http://kbbl", fetch: fetcher });
  expect((await client.usage("sid")).ok).toBe(false);
 }
});
test("observation cost uses the read credential and optional configuration", async () => {
 let request = "";
 const result = await readObservationCost({ url: "http://observation", namespace: "n", token: "secret", fetcher: async (url, init) => {
 request = `${url} ${new Headers(init?.headers).get("authorization")}`; return Response.json({ run_id: "run", charged_usd: .4 }); } }, "run");
 expect([result, request, await readObservationCost(null,"run")]).toEqual([{ ok: true, value: { run_id: "run", charged_usd: .4 } }, "http://observation/v1/runs/run/cost Bearer secret", { ok: true, value: null }]);
});
test("read boundary fetches each session once per read and degrades failed coverage", async () => {
 const a = attempt(1);
 const read = { run: { id: "run", created_at: new Date(0) }, attempts: [{ ...a, unit_id: "unit", worker: "builder", cause: { kind: "missing" } }, { ...attempt(2), kbbl_session_id: "failed", unit_id: "second-unit", worker: "builder", cause: { kind: "retry" } }],
 units: [{ id: "unit", stage: "implementation", collection_key: "cohort" }, { id:"second-unit",stage:"implementation",collection_key:"second-cohort" }], revisions: [], decisions: [], definition: { parsed_workflow: { stages: {} } } } as unknown as RunRead;
 let current = session([turn(selectDeliveryKey(a),2)]); let calls = 0;
 const kbbl = new KbblClient({ base_url: "http://kbbl", fetch: async (url) => { calls++; return String(url).includes("failed") ? new Response("bad", { status: 500 }) : Response.json(current); } });
 const first = await readUsageView(read, kbbl);
 current = session([...current.turns, turn("steering",8)]);
 const second = await readUsageView(read,kbbl,{ url: "http://observation", token: "read", namespace: "n", fetcher: async () => Response.json({ run_id: "run", charged_usd: .75 }) });
 expect([calls, first.coverage.turns,second.coverage.turns,second.coverage.failed_sessions,second.verification,second.units.length]).toEqual([4,1,2,["failed"],{ usd:.75, usd_basis:"provider_charged" },2]);
});

test("review time separates operator, engine and external waits and flags approximations", async () => {
 const { reviewTimes, elapsedTime } = await import("../src/projections/usage-time");
 const read = { run: { created_at: new Date(0) }, units: [{ id: "u", stage: "s" }],
  revisions: [{ id: "rev", created_at: new Date(1000), artifact: "pr" }],
  decisions: ["human","engine","merge_confirmation","pr_closed"].map((review,i) => ({ unit_id: "u", review, target_revision_id: "rev", decision: "approved", created_at: new Date(3000+i*1000) })),
  definition: { parsed_workflow: { stages: { s: { reviews: { human: { by: "operator", when: "guard" }, engine: { by: "engine" }, merge_confirmation: { by: "operator" }, pr_closed: { by: "operator" } }, workers: { refresh: { kind: "code", every: "1m", produces: ["pr"] } } } } } } } as unknown as RunRead;
 expect([reviewTimes(read).map((r) => [r.review,r.kind,r.wait_ms,r.approximate]), elapsedTime(read)]).toEqual([[["human","human",2000,true],["merge_confirmation","external",4000,true],["pr_closed","external",5000,true]],6000]);
});
test("missing cost preserves reported tokens, absent coverage and nullable totals", async () => {
 const { selectRunUsage } = await import("../src/projections/usage-view");
 const a = attempt(1);
 const reported = { ...turn(selectDeliveryKey(a),2), usage: { sid: "sid", turn_key: selectDeliveryKey(a), status: "reported" as const, input_tokens: 10, output_tokens: 2, cached_read_tokens: null, cached_write_tokens: null, thought_tokens: null, total_tokens: 12, model_usage: null, raw_json: null, recorded_at: date(5) } };
 const read = { run: { id: "run", created_at: new Date(0) }, attempts: [{ ...a, worker: "builder", unit_id: "u", cause: { kind: "missing" } }], units: [{ id: "u", stage: "s", collection_key: "c" }], revisions: [], decisions: [], definition: { parsed_workflow: { stages: {} } } } as unknown as RunRead;
 const usage = selectRunUsage(read,[session([reported,turn("absent",8)])],[],null);
 expect([usage.totals.tokens.total,usage.totals.usd,usage.coverage]).toEqual([12,null,{ turns:2,reported:1,partial:0,absent:1,cost_unreported_sessions:["sid"],failed_sessions:[] }]);
});
test("observation failures yield verification null", async () => {
 expect((await readObservationCost({ url:"http://observation", namespace:"n",token:"t",fetcher:async () => new Response("",{status:500}) },"run")).ok).toBe(false);
});

test("operator revisions and periodic refreshes remain first pass", () => {
 const attempts = [{ ...attempt(1), cause: { kind:"periodic" as const, inputs:"digest" } }, { ...attempt(2), cause: { kind:"review_of" as const, revision:"operator-edit" } }];
 expect([...classifyRework(attempts,[{ id:"operator-edit" as never,by_id:null,created_at:new Date(1500) }])]).toEqual([]);
});
