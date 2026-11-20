import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { type KbblSessionId } from "./types";
import { makeHarness, makeDirs, spec, until, shutdownHarnesses } from "./service-test-harness";

afterEach(shutdownHarnesses);

test("session/load rebuilds history after controller destruction", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });

  const ensured = await first.service.ensureResumableSession(
    "key-1",
    spec(workdir, "remember me"),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  const observed = await first.service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");

  // Simulate a kbbl restart: children die, in-memory controllers vanish,
  // the SQLite rows and the agent's own transcript store survive.
  await first.service.shutdown();
  const second = makeHarness({ stateDir, db: first.db });
  second.service.recoverOnBoot();

  const history = await second.service.loadHistory(sid);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  expect(history.value.expired).toBe(false);
  const replayedReply = history.value.transcript?.items.find(
    (event) =>
      event.kind === "agent_message" &&
      event.is_replayed &&
      event.text.includes("remember me"),
  );
  expect(replayedReply).toBeDefined();
}, 20000);

test("resume falls back to a saved handoff when the bounded transcript is incomplete", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({ stateDir, liveItemBuffer: 2 });
  const ensured = await service.ensureResumableSession("key-full-resume", spec(workdir, "remember the first turn"));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  const live = registry.getLive(sid as KbblSessionId);
  const sent = await service.sendInput(sid, "remember the second turn", { client_message_id: "second" });
  expect(sent.ok).toBe(true);
  await until(() => !live?.isPromptActive && live?.snapshotTranscript().items.some((item) =>
    item.kind === "agent_message" && item.text.includes("remember the second turn")));


  const history = await service.loadHistory(sid);
  if (!history.ok || history.value.kind !== "transcript") throw new Error("missing transcript");
  expect(history.value.transcript.is_truncated).toBe(true);
  expect(history.value.transcript.items).toHaveLength(2);
  expect(await service.loadResumeHistory(sid)).toMatchObject({ ok: true, value: { kind: "unavailable" } });

  const summary = store.putSessionSummary({
    schema_version: 1, session_id: sid, method: "manual_compaction",
    produced_at: new Date().toISOString(), markdown: "Saved handoff across both turns.",
  });
  expect(await service.loadResumeHistory(sid)).toMatchObject({ ok: true, value: { kind: "summary", summary } });
  expect(registry.getLive(sid as KbblSessionId)).toBe(live);
}, 20000);

test("canceling a resume interrupts its private history replay", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession("key-cancel-resume", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);

  const second = makeHarness({ stateDir, db: first.db, behavior: "delayed_load", delayMs: 2000 });
  const controller = new AbortController();
  const loading = second.service.loadResumeHistory(sid, controller.signal);
  setTimeout(() => controller.abort(), 50);
  const startedAt = Date.now();
  const result = await loading;
  expect(result.ok).toBe(false);
  expect(Date.now() - startedAt).toBeLessThan(1800);
  expect(second.registry.getLive(sid as KbblSessionId)).toBeNull();
}, 20000);

test("session/load replay does not rewrite live activity or notify the inbox", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });

  const ensured = await first.service.ensureResumableSession(
    "key-replay-activity",
    spec(workdir, "historical reply"),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const second = makeHarness({ stateDir, db: first.db });
  second.service.recoverOnBoot();
  const before = second.store.getSession(sid as KbblSessionId)?.last_activity_at;
  let inboxTicks = 0;
  const unsubscribe = second.service.subscribeSessionsChanged(() => {
    inboxTicks += 1;
  });

  const history = await second.service.loadHistory(sid);
  unsubscribe();
  expect(history.ok && !history.value.expired).toBe(true);
  expect(second.store.getSession(sid as KbblSessionId)?.last_activity_at).toBe(before);
  expect(inboxTicks).toBe(0);
}, 20000);

test("terminal history reads replay through a display-only ACP child", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession(
    "key-terminal-history",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  await service.closeSession(sid);
  expect(registry.getLive(sid as KbblSessionId)).toBeNull();

  const acquired = await service.openSessionStream(sid, () => {
    throw new Error("terminal snapshot must not subscribe");
  });
  if (!acquired.ok) throw new Error(acquired.error.detail);
  const { epoch_frame, release } = acquired.value;
  await release();
  expect(epoch_frame.history_kind).toBe("transcript");
  expect(epoch_frame.items.some((item) => item.kind === "agent_message")).toBe(true);
  if (epoch_frame.stream_epoch === null) throw new Error("terminal replay did not provide an epoch");
  const second = await service.openSessionStream(sid, () => {});
  if (!second.ok) throw new Error(second.error.detail);
  expect(second.value.epoch_frame.stream_epoch).toBe(epoch_frame.stream_epoch);
  await second.value.release();
  const page = service.readItemPage(sid, { epoch: epoch_frame.stream_epoch, before_seq: 100, limit: 100 });
  expect(page).toEqual({ ok: true, value: {
    kind: "page", stream_epoch: epoch_frame.stream_epoch, items: epoch_frame.items, has_earlier: false,
  } });
  expect(service.getSession(sid)?.status).toBe("ended");
  expect(registry.getLive(sid as KbblSessionId)).toBeNull();
}, 15000);

test("terminal history falls back to the persisted final response when agent replay expires", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });
  const ensured = await service.ensureResumableSession(
    "key-terminal-summary",
    spec(workdir, "remember this result"),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  const agentId = store.getSession(sid)?.acp_session_id;
  if (!agentId) throw new Error("missing agent session id");

  await service.closeSession(sid);
  expect(store.getSessionSummary(sid)?.markdown).toContain("remember this result");
  await unlink(join(stateDir, `${agentId}.jsonl`));

  const history = await service.loadHistory(sid);
  expect(history.ok && history.value.kind).toBe("summary");
  if (!history.ok || history.value.kind !== "summary") return;
  expect(history.value.summary.method).toBe("final_response");
  expect(history.value.summary.markdown).toContain("remember this result");
  await service.purgeSession(sid);
  expect(store.getSessionSummary(sid)).toBeNull();
}, 15000);

test("a cold history lease closes its display-only child on release", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession(
    "key-history-lease",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const second = makeHarness({ stateDir, db: first.db });
  const acquired = await second.service.acquireHistory(sid);
  expect(acquired.ok).toBe(true);
  if (!acquired.ok) return;
  expect(second.registry.getLive(sid as KbblSessionId)).not.toBeNull();

  await acquired.value.release();
  expect(second.registry.getLive(sid as KbblSessionId)).toBeNull();
}, 20000);

test("a history lease never closes a controller that was already live", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir });
  const ensured = await service.ensureResumableSession(
    "key-live-history-lease",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  const existing = registry.getLive(sid as KbblSessionId);

  const acquired = await service.acquireHistory(sid);
  if (!acquired.ok) throw new Error("history acquisition failed");
  await acquired.value.release();
  expect(registry.getLive(sid as KbblSessionId)).toBe(existing);
}, 15000);

test("concurrent cold history readers share one child until the final release", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession(
    "key-shared-history-lease",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const second = makeHarness({
    stateDir,
    db: first.db,
    behavior: "delayed_load",
    delayMs: 200,
  });
  const [left, right] = await Promise.all([
    second.service.acquireHistory(sid),
    second.service.acquireHistory(sid),
  ]);
  if (!left.ok || !right.ok) throw new Error("history acquisition failed");
  expect(second.registry.liveCount()).toBe(1);

  await left.value.release();
  expect(second.registry.liveCount()).toBe(1);
  await right.value.release();
  expect(second.registry.liveCount()).toBe(0);
}, 20000);

test("durable input takes ownership of a history-created controller", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession(
    "key-history-work-transfer",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const second = makeHarness({
    stateDir,
    db: first.db,
    behavior: "delayed",
    delayMs: 500,
  });
  const acquired = await second.service.acquireHistory(sid);
  if (!acquired.ok) throw new Error("history acquisition failed");
  const sent = await second.service.sendInput(sid, "keep this controller", {
    client_message_id: "history-transfer-1",
  });
  if (!sent.ok) throw new Error("input was not accepted");

  await acquired.value.release();
  expect(second.registry.getLive(sid as KbblSessionId)).not.toBeNull();
  await until(
    () =>
      second.store.getTurn(sid as KbblSessionId, sent.value.turn_key)?.status ===
      "succeeded",
    8000,
    "durable turn to survive history release",
  );
}, 20000);
