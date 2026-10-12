import { afterAll, beforeAll, expect, test } from "bun:test";
import type { DefinitionBundleId, RunId } from "../src/domain/primitives";
import { claimStart, listOwedIntents, markAcknowledged, readAttemptSession, readIntent, recordTryFailure, settleIntent } from "../src/storage/executor-store";
import { executor, launch, openAuthority, pinSample, submitter, unitOf, type Authority } from "./authority-fixture";

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

test("acknowledging keeps a stop requested meanwhile", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await submitter(authority)({ run_id, event: { kind: "cancel_requested" } });
  expect(await markAcknowledged(authority.db, intent_id)).toBe("stop_requested");
});

test("settling is final and leaves the intent off the owed list", async () => {
  const { run_id, intent_id } = await launchedIntent();
  await settleIntent(authority.db, { intent_id, status: "failed", last_error: "refused" });
  const again = await settleIntent(authority.db, { intent_id, status: "stopped", last_error: null });
  expect({ again, owed: await listOwedIntents(authority.db, run_id) }).toEqual({ again: "failed", owed: [] });
});

test("an attempt's session is the one it reported at start", async () => {
  const { run_id, intent_id } = await launchedIntent();
  const intent = await readIntent(authority.db, intent_id);
  const action = `${unitOf(run_id, "document")}:writer:Initial:Missing`;
  const before = await readAttemptSession(authority.db, { action_id: action, seq: intent!.seq });
  await submitter(authority)({ run_id, event: { kind: "worker_started", action, kbbl_session_id: "sid-42" }, writer: executor(action) });
  expect([before, await readAttemptSession(authority.db, { action_id: action, seq: intent!.seq })]).toEqual([null, "sid-42"]);
});

test("a missing intent reads and claims as missing", async () => {
  expect([await readIntent(authority.db, "missing"), await claimStart(authority.db, { intent_id: "missing", max_tries: 1 })])
    .toEqual([null, { kind: "missing" }]);
});
