import { afterEach, expect, test } from "bun:test";
import { join } from "node:path";
import { unlink } from "node:fs/promises";
import { type TurnKey, type KbblSessionId } from "./types";
import { makeHarness, makeDirs, spec, until, shutdownHarnesses } from "./service-test-harness";

afterEach(shutdownHarnesses);

test("happy path: ensure provisions, runs the initial prompt, reports terminal success", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  expect(ensured.value.kind).toBe("created");
  const sid = ensured.value.session.sid;

  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");
  const turn = store.getTurn(sid, "initial:key-1" as TurnKey);
  expect(turn?.status).toBe("succeeded");
  expect(turn?.stop_reason).toBe("end_turn");
}, 15000);

test("session creation preserves the adapter's underlying error in the durable failure", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir, behavior: "new_session_error" });
  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (ensured.ok) throw new Error("expected session creation to fail");
  const row = store.listSessions()[0]!;
  const observed = await service.observeInitialTurn(row.sid, 8000);
  if (!observed.ok || observed.value.kind !== "failed") {
    throw new Error("expected a durable failed observation");
  }
  expect(observed.value.failure_detail).toContain("Claude Code process exited with code 1");
}, 15000);

test("a session that died provisioning is observed with the code that killed it", async () => {
  // The observation is all a DBOS observer or the PWA ever sees, and
  // reporting every provisioning death as `agent_spawn_failed` said the
  // agent would not start — for an agent that started fine and was handed a
  // model it does not offer. The code is what tells an operator whether to
  // fix a config or rerun.
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", {
    ...spec(workdir),
    model: "gpt-6-astra",
  });
  expect(ensured.ok).toBe(false);
  if (ensured.ok) return;
  expect(ensured.error.code).toBe("requested_model_unsupported");

  const row = store.listSessions()[0]!;
  expect(row.status).toBe("failed");
  const observed = await service.observeInitialTurn(row.sid, 8000);
  expect(observed.ok).toBe(true);
  if (!observed.ok) return;
  expect(observed.value.kind).toBe("failed");
  if (observed.value.kind !== "failed") return;
  expect(observed.value.failure_code).toBe("requested_model_unsupported");
  // The detail is persisted beside the code, so the observation names the
  // model that was refused rather than echoing the code back.
  expect(observed.value.failure_detail).toBe(ensured.error.detail);
  expect(observed.value.failure_detail).toContain("gpt-6-astra");
}, 15000);

test("the prompt response is the terminal success signal — the child stays alive past it", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");

  // Terminality came from the PromptResponse; the agent process was not
  // exited to produce it.
  const controller = registry.getLive(sid as KbblSessionId);
  expect(controller).not.toBeNull();
  expect(controller?.isPromptActive).toBe(false);
  expect(service.getSession(sid)?.status).toBe("idle");
}, 15000);

test("one session gets exactly one child across multiple turns", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  const pidBefore = registry.getLive(sid as KbblSessionId)?.childPid;
  expect(pidBefore).toBeGreaterThan(0);

  const sent = await service.sendInput(sid, "follow-up", { delivery_key: "delivery-1" });
  expect(sent.ok).toBe(true);
  await until(
    () => store.getTurn(sid as KbblSessionId, "delivery-1" as TurnKey)?.status === "succeeded",
    8000,
    "second turn to complete",
  );
  expect(registry.getLive(sid as KbblSessionId)?.childPid).toBe(pidBefore!);
  expect(registry.liveCount()).toBe(1);
}, 15000);

test("20 concurrent ensures for one key create one session and one child", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({ stateDir });

  const results = await Promise.all(
    Array.from({ length: 20 }, () =>
      service.ensureResumableSession("key-1", spec(workdir)),
    ),
  );
  const outcomes = results.map((result) => {
    if (!result.ok) throw new Error(`ensure failed: ${result.error.code}`);
    return result.value;
  });
  expect(outcomes.filter((outcome) => outcome.kind === "created")).toHaveLength(1);
  expect(new Set(outcomes.map((outcome) => outcome.session.sid)).size).toBe(1);
  expect(store.listSessions()).toHaveLength(1);

  const sid = outcomes[0]!.session.sid;
  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");
  expect(registry.liveCount()).toBe(1);
}, 20000);

test("same delivery key with the same body dedupes to one turn", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);

  const first = await service.sendInput(sid, "same text", { delivery_key: "delivery-1" });
  const second = await service.sendInput(sid, "same text", { delivery_key: "delivery-1" });
  expect(first.ok && second.ok).toBe(true);
  if (!first.ok || !second.ok) return;
  expect(second.value.turn_key).toBe(first.value.turn_key);
  expect(second.value.payload_hash).toBe(first.value.payload_hash);
  const turns = store.listAcceptedTurns(sid as KbblSessionId);
  // At most the one delivery is pending; a duplicate row would show here.
  expect(turns.length).toBeLessThanOrEqual(1);
}, 15000);

test("same delivery key with a different body conflicts", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);

  await service.sendInput(sid, "one body", { delivery_key: "delivery-1" });
  const conflict = await service.sendInput(sid, "another body", { delivery_key: "delivery-1" });
  expect(!conflict.ok && conflict.error.code).toBe("delivery_key_conflict");
}, 15000);

test("collaboration revives an ended resumable session with its sid and transcript", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });
  const ensured = await service.ensureResumableSession("key-review", spec(workdir, "remember the first turn"));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  await service.closeSession(sid);
  expect(store.getSession(sid as KbblSessionId)?.status).toBe("ended");

  const revived = await service.reviveResumable("key-review");
  expect(revived.ok && revived.value.sid).toBe(sid);
  const history = await service.loadHistory(sid);
  expect(history.ok && history.value.transcript?.items.some((event) =>
    event.kind === "user_message" && event.text === "remember the first turn")).toBe(true);
  const sent = await service.sendInput(sid, "review this", { delivery_key: "collaboration:review" });
  expect(sent.ok).toBe(true);
  expect(store.getTurn(sid as KbblSessionId, "initial:key-review" as TurnKey)?.status).toBe("succeeded");
}, 15000);

test("operator input to a busy session is accepted durably and dispatched afterwards", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({
    stateDir,
    behavior: "delayed",
    delayMs: 800,
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status ===
      "prompting",
    5000,
    "initial turn to start prompting",
  );

  const queued = await service.sendInput(sid, "operator interjection", {
    client_message_id: "operator-1",
  });
  expect(queued.ok).toBe(true);
  if (!queued.ok) return;
  expect(queued.value.status).toBe("accepted");

  const turnKey = queued.value.turn_key;
  expect(store.getTurn(sid as KbblSessionId, turnKey)?.status).toBe("accepted");
  const history = await service.loadHistory(sid);
  if (!history.ok) throw new Error("history load failed");
  expect(history.value.openTurns).toContainEqual({
    turnKey,
    source: "operator",
    text: "operator interjection",
    status: "accepted",
    createdAt: queued.value.created_at,
  });
  await until(
    () => store.getTurn(sid as KbblSessionId, turnKey)?.status === "succeeded",
    10000,
    "queued operator turn to run after the active turn",
  );
}, 20000);

test("collaboration delivery to a busy session is accepted durably and dispatched afterwards", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({
    stateDir,
    behavior: "delayed",
    delayMs: 800,
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status ===
      "prompting",
    5000,
    "initial turn to start prompting",
  );

  const delivered = await service.sendInput(sid, "queued while busy", { delivery_key: "delivery-1" });
  expect(delivered.ok).toBe(true);
  if (!delivered.ok) return;
  expect(delivered.value.status).toBe("accepted");

  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "delivery-1" as TurnKey)?.status ===
      "succeeded",
    10000,
    "queued delivery to run after the active turn",
  );
}, 20000);

test("cancel maps to session/cancel and records a cancelled turn", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({
    stateDir,
    behavior: "delayed",
    delayMs: 5000,
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status ===
      "prompting",
    5000,
    "initial turn to start prompting",
  );

  const cancelled = await service.cancelTurn(sid);
  expect(cancelled.ok).toBe(true);
  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status ===
      "cancelled",
    5000,
    "turn to record cancellation",
  );
  const turn = store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey);
  expect(turn?.stop_reason).toBe("cancelled");
}, 15000);

test("fence cancels, closes, kills the child, and rejects later input — idempotently", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({
    stateDir,
    behavior: "delayed",
    delayMs: 5000,
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await until(
    () =>
      store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status ===
      "prompting",
    5000,
    "initial turn to start prompting",
  );

  const fenced = await service.closeSession(sid, { fenced_by: "exec-99" });
  expect(fenced.ok).toBe(true);
  const row = store.getSession(sid as KbblSessionId);
  expect(row?.status).toBe("fenced");
  expect(row?.fenced_by).toBe("exec-99");
  expect(registry.getLive(sid as KbblSessionId)).toBeNull();

  const rejected = await service.sendInput(sid, "too late", { delivery_key: "delivery-9" });
  expect(!rejected.ok && rejected.error.code).toBe("session_fenced");

  const again = await service.closeSession(sid, { fenced_by: "exec-99" });
  expect(again.ok).toBe(true);
}, 20000);

test("cold fencing captures a summary through display-only history before terminalizing", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession(
    "key-cold-fence",
    spec(workdir, "preserve this fenced result"),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  const agentId = first.store.getSession(sid)?.acp_session_id;
  if (!agentId) throw new Error("missing agent session id");
  await first.service.shutdown();

  const second = makeHarness({ stateDir, db: first.db });
  expect(second.registry.getLive(sid)).toBeNull();
  const fenced = await second.service.closeSession(sid, { fenced_by: "exec-cold" });
  expect(fenced.ok).toBe(true);
  expect(second.store.getSession(sid)?.status).toBe("fenced");
  expect(second.store.getSessionSummary(sid)?.markdown).toContain("preserve this fenced result");
  expect(second.registry.getLive(sid)).toBeNull();

  await unlink(join(stateDir, `${agentId}.jsonl`));
  const history = await second.service.loadHistory(sid);
  expect(history.ok && history.value.kind).toBe("summary");
}, 20000);

test("advancing a cold resumable session preserves its summary before detaching the key", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });
  const ensured = await first.service.ensureResumableSession(
    "key-cold-advance",
    spec(workdir, "preserve this advanced result"),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();

  const second = makeHarness({ stateDir, db: first.db });
  const advanced = await second.service.advanceResumable("key-cold-advance");
  expect(advanced.kind).toBe("advanced");
  expect(second.store.getSessionSummary(sid)?.markdown).toContain("preserve this advanced result");
  expect(second.store.getSession(sid)?.resumable_key).toBeNull();
  expect(second.registry.getLive(sid)).toBeNull();
}, 20000);

test("an unprompted session survives idle reaping and delivers queued input once", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir, behavior: "persist_on_prompt" });
  const created = await first.service.createSession({ ...spec(workdir, ""), model: "fake-large", effort: "high" });
  if (!created.ok) throw new Error(created.error.detail);
  const sid = created.value.sid;
  const original = first.store.getSession(sid);
  await first.service.reapIdleChildren(Date.now() + 900001);
  expect(first.registry.getLive(sid)).toBeNull();

  const accepted = first.store.acceptTurn({ sid, turn_key: "operator:review" as TurnKey, source: "operator", payload: "handle the review" });
  expect(accepted.kind).toBe("created");
  const second = makeHarness({ stateDir, db: first.db, behavior: "persist_on_prompt" });
  second.service.recoverOnBoot();
  const history = await second.service.loadHistory(sid);
  expect(history.ok && !history.value.expired).toBe(true);
  await until(() => second.store.getTurn(sid, "operator:review" as TurnKey)?.status === "succeeded");
  expect(second.store.getSession(sid)?.acp_session_id).not.toBe(original?.acp_session_id);
  expect(second.store.getSession(sid)?.worktree_path).toBe(original?.worktree_path);
  const controller = second.registry.getLive(sid);
  expect(controller?.liveConfigOptions.map(option => option.currentValue)).toEqual(["fake-large", "high", "default"]);
  const replay = await second.service.sendInput(sid, "handle the review", { client_message_id: "review" });
  expect(replay.ok && replay.value.status).toBe("succeeded");
}, 15000);

test("a missing transcript after a dispatched turn never starts an empty replacement", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir });
  const created = await service.createSession(spec(workdir));
  if (!created.ok) throw new Error(created.error.detail);
  const sid = created.value.sid;
  await service.observeInitialTurn(sid, 8000);
  const agentId = store.getSession(sid)?.acp_session_id;
  await service.shutdown();
  await unlink(join(stateDir, `${agentId}.jsonl`));
  const history = await service.loadHistory(sid);
  expect(history.ok && history.value.expired).toBe(true);
  expect(store.getSession(sid)?.acp_session_id).toBe(agentId);
}, 15000);
