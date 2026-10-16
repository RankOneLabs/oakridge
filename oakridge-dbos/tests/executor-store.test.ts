import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { abandonIntent, claimStart, listOwedIntents, markAcknowledged, readAttemptSession, readIntent, recordTryFailure, settleIntent, settleStartIntent } from "../src/storage/executor-store";
import { actionOf, executor, launch, openAuthority, pinSample, submitter, type Authority } from "./authority-fixture";

let authority: Authority;
let bundle_id: DefinitionBundleId;
beforeAll(async () => {
  authority = await openAuthority();
  ({ bundle_id } = await pinSample(authority));
});
afterAll(async () => { await authority.close(); });

async function launchedIntent(): Promise<{ readonly run_id: RunId; readonly intent_id: string }> {
  const { run_id, result } = await launch(authority, { bundle_id, request_id: crypto.randomUUID(), input: { topic: "Oakridge" } });
  if (!result.ok || result.value.kind !== "committed") throw new Error("launch failed");
  const [owed] = await listOwedIntents(authority.db, run_id);
  if (!owed) throw new Error("launch wanted no worker");
  return { run_id, intent_id: owed.id };
}

test("a start claim counts tries and refuses past the budget", async () => {
  const { intent_id } = await launchedIntent();
  const claims = [];
  for (let index = 0; index < 3; index++) claims.push(await claimStart(authority.db, { intent_id, max_tries: 2 }));
  expect(claims).toEqual([{ kind: "claimed", tries: 1 }, { kind: "claimed", tries: 2 }, { kind: "exhausted", tries: 2 }]);
});

test("only a pending intent can be claimed", async () => {
  const { intent_id } = await launchedIntent();
  await markAcknowledged(authority.db, intent_id);
  expect(await claimStart(authority.db, { intent_id, max_tries: 3 })).toEqual({ kind: "not_pending", status: "acknowledged" });
});

test("a try failure records the error and the next try time", async () => {
  const { intent_id } = await launchedIntent();
  const next_try_at = new Date(Date.now() + 60_000);
  await recordTryFailure(authority.db, { intent_id, last_error: "kbbl unavailable", next_try_at });
  const intent = await readIntent(authority.db, intent_id);
  expect({ last_error: intent?.last_error, next_try_at: intent?.next_try_at?.getTime() })
    .toEqual({ last_error: "kbbl unavailable", next_try_at: next_try_at.getTime() });
});

test("a try failure that lands after the intent settled keeps the error it settled with", async () => {
  const { intent_id } = await launchedIntent();
  await settleIntent(authority.db, { intent_id, status: "stopped", last_error: "confirmed" });
  const status = await recordTryFailure(authority.db, { intent_id, last_error: "late", next_try_at: new Date(Date.now() + 60_000) });
  const intent = await readIntent(authority.db, intent_id);
  expect({ status, last_error: intent?.last_error, next_try_at: intent?.next_try_at ?? null })
    .toEqual({ status: "stopped", last_error: "confirmed", next_try_at: null });
});

test("acknowledging keeps a stop requested meanwhile", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  expect(await markAcknowledged(authority.db, intent_id)).toBe("stop_requested");
});

test("a turn ending after a stop request leaves cleanup owed", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await markAcknowledged(authority.db, intent_id);
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  const after_turn = await settleStartIntent(authority.db, { intent_id, status: "stopped", last_error: null });
  const owed = await listOwedIntents(authority.db, run_id);
  expect({ after_turn, owed: owed.map((intent) => intent.status) }).toEqual({ after_turn: "stop_requested", owed: ["stop_requested"] });
});

test("settling is final and leaves the intent off the owed list", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await settleIntent(authority.db, { intent_id, status: "failed", last_error: "refused" });
  const again = await settleIntent(authority.db, { intent_id, status: "stopped", last_error: null });
  expect({ again, owed: await listOwedIntents(authority.db, run_id) }).toEqual({ again: "failed", owed: [] });
});

test("abandoning a live intent requests its stop and keeps it owed until a stop settles it", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await markAcknowledged(authority.db, intent_id);
  const abandoned = await abandonIntent(authority.db, { intent_id, last_error: "observation_unavailable: lost" });
  const owed = await listOwedIntents(authority.db, run_id);
  expect({ abandoned, owed: owed.map(({ id, status }) => ({ id: String(id), status })), last_error: (await readIntent(authority.db, intent_id))?.last_error })
    .toEqual({ abandoned: "stop_requested", owed: [{ id: intent_id, status: "stop_requested" }], last_error: "observation_unavailable: lost" });
});

test("abandoning a settled intent leaves it settled", async () => {
  const { intent_id } = await launchedIntent();
  await settleIntent(authority.db, { intent_id, status: "failed", last_error: "refused" });
  expect(await abandonIntent(authority.db, { intent_id, last_error: "late" })).toBe("failed");
});

test("an attempt's session is the one it reported at start", async () => {
  const { run_id, intent_id } = await launchedIntent();
  const intent = await readIntent(authority.db, intent_id);
  const action = await actionOf(authority, run_id, "writer");
  const before = await readAttemptSession(authority.db, { action_id: action, seq: intent!.seq });
  await submitter(authority)({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid-42" }, writer: executor(action) });
  expect([before, await readAttemptSession(authority.db, { action_id: action, seq: intent!.seq })]).toEqual([null, "sid-42"]);
});

test("a missing intent reads and claims as missing", async () => {
  expect([await readIntent(authority.db, "missing"), await claimStart(authority.db, { intent_id: "missing", max_tries: 1 })])
    .toEqual([null, { kind: "missing" }]);
});
