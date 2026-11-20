import { afterEach, expect, test } from "bun:test";
import { type AcpControllerRegistry } from "./controller-registry";
import { type SessionWireFrame } from "./session-wire";
import { type TurnKey, type AcpUiEvent, type KbblSessionId } from "./types";
import { makeHarness, makeDirs, spec, until, shutdownHarnesses } from "./service-test-harness";

afterEach(shutdownHarnesses);

test("an agent without loadSession is rejected for a load-requiring profile", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir, behavior: "no_load" });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  expect(!ensured.ok && ensured.error.code).toBe(
    "acp_required_capability_missing",
  );
  // The failure is a visible failed session, not an invisible claim.
  const rows = store.listSessions();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("failed");

  const observed = await service.observeInitialTurn(rows[0]!.sid, 1000);
  expect(observed.ok && observed.value.kind).toBe("failed");
}, 15000);

test("process exit during a prompt reports a lost initial turn as terminal without retrying it", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({
    stateDir,
    behavior: "crash_mid_prompt",
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;

  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok).toBe(true);
  if (!observed.ok) return;
  expect(observed.value.kind).toBe("failed");
  expect(store.getTurn(sid as KbblSessionId, "initial:key-1" as TurnKey)?.status).toBe(
    "unknown",
  );
  expect(registry.getLive(sid as KbblSessionId)).toBeNull();
}, 15000);

test("boot sweep + retained accepted turn: dispatched exactly once on the next touch", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });

  const ensured = await first.service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid as KbblSessionId;
  await first.service.observeInitialTurn(sid, 8000);

  // Ledger writes as they would exist after a crash: one turn that had
  // reached `prompting`, one still `accepted` (never sent).
  first.store.acceptTurn({
    sid,
    turn_key: "was-prompting" as TurnKey,
    source: "collaboration",
    payload: "in flight during crash",
  });
  first.store.markTurnPrompting(sid, "was-prompting" as TurnKey);
  first.store.acceptTurn({
    sid,
    turn_key: "still-accepted" as TurnKey,
    source: "collaboration",
    payload: "acknowledged but never sent",
  });
  await first.service.shutdown();

  const second = makeHarness({ stateDir, db: first.db });
  second.service.recoverOnBoot();
  expect(second.store.getTurn(sid, "was-prompting" as TurnKey)?.status).toBe(
    "unknown",
  );
  expect(second.store.getTurn(sid, "still-accepted" as TurnKey)?.status).toBe(
    "accepted",
  );

  // The §10.7 lazy touch: an ensure for the same key attaches and kicks
  // the retained turn through a fresh child + session/load.
  const reEnsured = await second.service.ensureResumableSession(
    "key-1",
    spec(workdir),
  );
  expect(reEnsured.ok && reEnsured.value.kind).toBe("existing");
  await until(
    () => second.store.getTurn(sid, "still-accepted" as TurnKey)?.status === "succeeded",
    10000,
    "retained accepted turn to dispatch",
  );
  // The unknown turn stays unknown — never auto-retried.
  expect(second.store.getTurn(sid, "was-prompting" as TurnKey)?.status).toBe(
    "unknown",
  );
}, 25000);

test("stderr spam does not corrupt the ACP protocol stream", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir, behavior: "stderr_spam" });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");
  // The noise really was flowing on stderr while the protocol succeeded.
  const controller = registry.getLive(sid as KbblSessionId);
  expect((controller?.stderrTail().length ?? 0) > 0).toBe(true);
}, 15000);

test("a missing agent binary records a visible failed session", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({
    stateDir,
    command: "/nonexistent/acp-agent-binary",
  });

  const ensured = await service.ensureResumableSession("key-1", spec(workdir));
  expect(ensured.ok).toBe(false);
  const rows = store.listSessions();
  expect(rows).toHaveLength(1);
  expect(rows[0]!.status).toBe("failed");
}, 15000);

test("operator input whose immediate touch fails remains accepted for recovery", async () => {
  const { stateDir, workdir } = await makeDirs();
  const first = makeHarness({ stateDir });

  const ensured = await first.service.ensureResumableSession(
    "key-1",
    spec(workdir),
  );
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  const observed = await first.service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");

  // Restart onto a broken agent binary so the lazy respawn (touch) fails.
  await first.service.shutdown();
  const broken = makeHarness({
    stateDir,
    db: first.db,
    command: "/nonexistent/acp-agent-binary",
  });
  broken.service.recoverOnBoot();

  const sent = await broken.service.sendInput(sid, "recoverable operator input", {
    client_message_id: "recoverable-1",
  });
  expect(sent.ok).toBe(true);
  expect(broken.store.listAcceptedTurns(sid as KbblSessionId)).toHaveLength(1);
  const acceptedTurn = broken.db
    .prepare<{ status: string }, [string]>(
      "SELECT status FROM acp_turns WHERE sid = ? AND source = 'operator'",
    )
    .get(sid);
  expect(acceptedTurn?.status).toBe("accepted");

  // Restart onto a working binary: the retained accepted turn dispatches.
  await broken.service.shutdown();
  const healthy = makeHarness({ stateDir, db: first.db });
  healthy.service.recoverOnBoot();
  const history = await healthy.service.loadHistory(sid);
  expect(history.ok && !history.value.expired).toBe(true);
  await until(
    () =>
      healthy.db
        .prepare<{ status: string }, [string]>(
          "SELECT status FROM acp_turns WHERE sid = ? AND source = 'operator'",
        )
        .get(sid)?.status === "succeeded",
    8000,
    "retained operator turn to dispatch after recovery",
  );
  const afterTouch = healthy.db
    .prepare<{ status: string }, [string]>(
      "SELECT status FROM acp_turns WHERE sid = ? AND source = 'operator'",
    )
    .get(sid);
  expect(afterTouch?.status).toBe("succeeded");
  const reloaded = await healthy.service.loadHistory(sid);
  expect(reloaded.ok).toBe(true);
  if (!reloaded.ok) return;
  const recoveredEvent = reloaded.value.transcript?.items.find(
    (event) =>
      (event.kind === "user_message" || event.kind === "agent_message") &&
      event.text.includes("recoverable"),
  );
  expect(recoveredEvent).toBeDefined();
}, 25000);

test("operator retry with the same client_message_id returns the stored receipt even while that turn is prompting", async () => {
  const { stateDir, workdir } = await makeDirs();
  const harness = makeHarness({ behavior: "delayed", stateDir, delayMs: 800 });
  const created = await harness.service.createSession(spec(workdir, ""));
  if (!created.ok) throw new Error(`createSession failed: ${created.error.code}`);
  const sid = created.value.sid;

  const first = await harness.service.sendInput(sid, "do the work", {
    client_message_id: "msg-1",
  });
  if (!first.ok) throw new Error(`first send failed: ${first.error.code}`);

  await until(
    () => harness.store.getSession(sid)?.status === "prompting",
    8000,
    "operator turn prompting",
  );

  // §14.5: a retry of the SAME message is answered with its receipt.
  const retry = await harness.service.sendInput(sid, "do the work", {
    client_message_id: "msg-1",
  });
  if (!retry.ok) throw new Error(`retry rejected: ${retry.error.code}`);
  expect(retry.value.turn_key).toBe(first.value.turn_key);

  const differentText = await harness.service.sendInput(sid, "different text", {
    client_message_id: "msg-1",
  });
  expect(!differentText.ok && differentText.error.code).toBe("delivery_key_conflict");

  const newInput = await harness.service.sendInput(sid, "unrelated", {
    client_message_id: "msg-2",
  });
  expect(newInput.ok && newInput.value.status).toBe("accepted");
  if (!newInput.ok) return;
  expect(newInput.value.turn_key).not.toBe(first.value.turn_key);
  await until(
    () =>
      harness.store.getTurn(sid, newInput.value.turn_key)?.status ===
      "succeeded",
    10000,
    "second operator turn to dispatch",
  );
}, 20000);

// === PWA cutover surface (§13/§14): dispatch echo, permission lifecycle,
// load-path config options, sessions change feed ===

test("dispatching a turn projects the prompt as a user_message UI event", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession(
    "key-echo",
    spec(workdir, "say hello"),
  );
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);

  const history = await service.loadHistory(sid);
  expect(history.ok).toBe(true);
  if (!history.ok) return;
  const userEvents = history.value.transcript?.items.filter(
    (event) => event.kind === "user_message",
  );
  expect(userEvents).toHaveLength(1);
  expect(userEvents?.[0]).toMatchObject({
    turn_key: "initial:key-echo",
    text: "say hello",
    is_replayed: false,
  });
}, 15000);

test("permission answer emits permission_resolved and drops the pending count", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir, behavior: "permission" });

  const ensured = await service.ensureResumableSession("key-perm", spec(workdir));
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;

  const events: AcpUiEvent[] = [];
  await until(() => service.subscribe(sid, ({ event }) => events.push(event)) !== null);
  const permission = await until(
    () =>
      events.find(
        (event): event is Extract<AcpUiEvent, { kind: "permission" }> =>
          event.kind === "permission",
      ),
    8000,
    "permission request",
  );
  expect(service.pendingPermissionCount(sid)).toBe(1);

  const resolved = service.resolvePermission(sid, permission.requestId, "allow");
  expect(resolved.ok).toBe(true);
  expect(service.pendingPermissionCount(sid)).toBe(0);

  const resolvedEvent = events.find(
    (event) => event.kind === "permission_resolved",
  );
  expect(resolvedEvent).toMatchObject({
    requestId: permission.requestId,
    outcome: "selected",
    optionId: "allow",
  });

  const observed = await service.observeInitialTurn(sid, 8000);
  expect(observed.ok && observed.value.kind).toBe("succeeded");
  expect(store.getSession(sid)?.status).toBe("idle");
}, 20000);

test("fence cancels pending permissions with a permission_resolved cancellation", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service } = makeHarness({ stateDir, behavior: "permission" });

  const ensured = await service.ensureResumableSession(
    "key-perm-fence",
    spec(workdir),
  );
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;

  const events: AcpUiEvent[] = [];
  await until(() => service.subscribe(sid, ({ event }) => events.push(event)) !== null);
  await until(
    () => service.pendingPermissionCount(sid) > 0,
    8000,
    "pending permission",
  );

  await service.closeSession(sid, { fenced_by: "op-99" });
  const cancelledEvent = events.find(
    (event) => event.kind === "permission_resolved",
  );
  expect(cancelledEvent).toMatchObject({ outcome: "cancelled" });
  expect(service.pendingPermissionCount(sid)).toBe(0);
}, 20000);

test("session/load restores the requested config and re-emits its selectors", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir });

  const ensured = await service.ensureResumableSession("key-cfg", {
    ...spec(workdir),
    model: "fake-large",
    effort: "high",
  });
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);

  // Kill the child; the next history load respawns via session/load.
  const controller = registry.getLive(sid as KbblSessionId);
  expect(controller).not.toBeNull();
  await controller!.closeChild();

  const reloaded = await service.loadHistory(sid);
  expect(reloaded.ok).toBe(true);
  if (!reloaded.ok) return;
  expect(reloaded.value.expired).toBe(false);
  expect(reloaded.value.transcript?.live_state.config_options).toEqual(expect.arrayContaining([
    expect.objectContaining({ category: "model", value: "fake-large" }),
    expect.objectContaining({ category: "thought_level", value: "high" }),
  ]));
}, 20000);

function liveMode(registry: AcpControllerRegistry, sid: string): unknown {
  const option = registry
    .getLive(sid as KbblSessionId)
    ?.liveConfigOptions.find((candidate) => candidate.category === "mode");
  return option?.currentValue ?? null;
}

test("a new session starts in its profile's session mode", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry, store } = makeHarness({ stateDir, sessionMode: "auto" });

  const ensured = await service.ensureResumableSession("key-mode", spec(workdir));
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;

  expect(liveMode(registry, sid)).toBe("auto");
  expect(store.getSession(sid as KbblSessionId)?.requested_mode).toBe("auto");
}, 20000);

test("an operator's mode change survives the agent respawning", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir, sessionMode: "auto" });

  const ensured = await service.ensureResumableSession("key-mode-toggle", spec(workdir));
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);

  const toggled = await service.setConfigOption(sid, "mode", "acceptEdits");
  expect(toggled.ok).toBe(true);
  // The respawned fake agent reports its default mode again; kbbl must
  // re-apply the operator's choice rather than the profile default.
  await registry.getLive(sid as KbblSessionId)!.closeChild();
  const reloaded = await service.loadHistory(sid);
  expect(reloaded.ok).toBe(true);

  expect(liveMode(registry, sid)).toBe("acceptEdits");
}, 20000);

test("a session mode the agent does not offer leaves the session running", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir, sessionMode: "no-such-mode" });

  const ensured = await service.ensureResumableSession("key-mode-miss", spec(workdir));
  expect(ensured.ok).toBe(true);
  if (!ensured.ok) return;

  expect(liveMode(registry, ensured.value.session.sid)).toBe("default");
}, 20000);

test("sessions change feed fires on session writes and stops after unsubscribe", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service } = makeHarness({ stateDir });

  let ticks = 0;
  const unsubscribe = service.subscribeSessionsChanged(() => {
    ticks += 1;
  });
  const ensured = await service.ensureResumableSession("key-feed", spec(workdir));
  expect(ensured.ok).toBe(true);
  expect(ticks).toBeGreaterThan(0);

  const beforeClose = ticks;
  if (ensured.ok) await service.closeSession(ensured.value.session.sid);
  expect(ticks).toBeGreaterThan(beforeClose);

  unsubscribe();
  const afterUnsubscribe = ticks;
  await service.ensureResumableSession("key-feed-2", spec(workdir));
  expect(ticks).toBe(afterUnsubscribe);
}, 20000);

test("subscribers see transcript updates before the corresponding turn frame", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, registry } = makeHarness({ stateDir });
  const ensured = await service.ensureResumableSession("key-transcript-frames", spec(workdir));
  if (!ensured.ok) throw new Error("ensure failed");
  const sid = ensured.value.session.sid;
  await service.observeInitialTurn(sid, 8000);
  const controller = registry.getLive(sid);
  if (!controller) throw new Error("missing controller");
  const frames: SessionWireFrame[] = [];
  const visiblePrompts: boolean[] = [];
  const stream = await service.openSessionStream(sid, (batch) => {
    frames.push(...batch);
    if (batch.some((frame) => frame.kind === "item" && frame.item.kind === "user_message")) {
      visiblePrompts.push(controller.snapshotTranscript().items.some((item) =>
        item.kind === "user_message" && item.turn_key === "operator:frames"));
    }
  });
  if (!stream.ok) throw new Error(stream.error.detail);
  expect(stream.value.epoch_frame.items).toEqual(controller.snapshotTranscript().items);
  try {
    const sent = await service.sendInput(sid, "check transcript frames", { client_message_id: "frames" });
    expect(sent.ok).toBe(true);
    await until(() => frames.some((frame) => frame.kind === "turn_state" && frame.state === "idle"));
    expect(visiblePrompts).toEqual([true]);
    expect(frames.filter((frame) =>
      (frame.kind === "item" && frame.item.kind === "user_message") ||
      (frame.kind === "turn_state" && frame.state === "prompting"),
    ).map((frame) => frame.kind)).toEqual(["item", "turn_state"]);
    expect(controller.snapshotTranscript().items).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: "user_message", turn_key: "operator:frames", text: "check transcript frames" }),
      expect.objectContaining({ kind: "agent_message", text: expect.stringContaining("check transcript frames") }),
    ]));
  } finally {
    await stream.value.release();
  }
}, 15000);
