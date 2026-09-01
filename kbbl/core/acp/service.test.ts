// Integration tests for the ACP substrate: real child processes running
// the fake ACP agent over stdio, real SQLite, the full
// service -> registry -> controller -> client -> supervisor path.

import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Database } from "bun:sqlite";

import { openTestDb } from "../db/test-db";
import type { AgentProfile, AgentProfileId } from "./agent-profile";
import { AcpControllerRegistry } from "./controller-registry";
import { AcpProcessSupervisor } from "./process-supervisor";
import { AcpSessionService } from "./session-service";
import { AcpSessionStore } from "./store";
import {
  ok,
  type AcpSessionStartSpec,
  type KbblSessionId,
  type TurnKey,
  type WorktreeProvider,
} from "./types";

const FIXTURE = join(import.meta.dir, "__fixtures__", "fake-acp-agent.ts");

interface Harness {
  db: Database;
  store: AcpSessionStore;
  registry: AcpControllerRegistry;
  service: AcpSessionService;
}

interface HarnessOptions {
  behavior?: string;
  stateDir: string;
  delayMs?: number;
  db?: Database;
  command?: string;
}

const openHarnesses: Harness[] = [];

afterEach(async () => {
  for (const harness of openHarnesses.splice(0)) {
    await harness.service.shutdown();
  }
});

function makeHarness(options: HarnessOptions): Harness {
  const db = options.db ?? openTestDb();
  const store = new AcpSessionStore(db);
  const registry = new AcpControllerRegistry();
  const supervisor = new AcpProcessSupervisor({
    graceful_kill_ms: 1000,
    hard_kill_ms: 1000,
  });
  const profile: AgentProfile = {
    id: "fake",
    label: "Fake agent",
    command: options.command ?? process.execPath,
    args: options.command ? [] : [FIXTURE],
    env_policy: {
      inherit: true,
      set: {
        FAKE_ACP_BEHAVIOR: options.behavior ?? "happy",
        FAKE_ACP_STATE_DIR: options.stateDir,
        ...(options.delayMs !== undefined
          ? { FAKE_ACP_DELAY_MS: String(options.delayMs) }
          : {}),
      },
    },
    enabled: true,
    requireLoadSession: true,
  };
  const profiles = new Map<AgentProfileId, AgentProfile>([["fake", profile]]);
  const worktrees: WorktreeProvider = {
    resolve: async (_sid, spec) =>
      ok({
        worktree_path: spec.workdir,
        worktree_branch: null,
        worktree_base_ref: null,
        parent_sid: null,
      }),
  };
  const service = new AcpSessionService({
    store,
    controllers: registry,
    profiles,
    supervisor,
    worktrees,
    config: {
      default_agent: "fake",
      graceful_kill_ms: 1000,
      idle_child_ttl_ms: 900000,
      live_event_buffer: 2000,
    },
  });
  const harness: Harness = { db, store, registry, service };
  openHarnesses.push(harness);
  return harness;
}

async function makeDirs(): Promise<{ stateDir: string; workdir: string }> {
  return {
    stateDir: await mkdtemp(join(tmpdir(), "fake-acp-state-")),
    workdir: await mkdtemp(join(tmpdir(), "fake-acp-work-")),
  };
}

function spec(workdir: string, prompt = "build the thing"): AcpSessionStartSpec {
  return { initial_prompt: prompt, workdir, runtime: "fake" };
}

async function until<T>(
  probe: () => T | null | undefined | false,
  timeoutMs = 8000,
  what = "condition",
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

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

test("operator input to a busy session answers busy instead of queueing", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({
    stateDir,
    behavior: "delayed",
    delayMs: 3000,
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

  const busy = await service.sendInput(sid, "operator interjection");
  expect(!busy.ok && busy.error.code).toBe("session_busy");
}, 15000);

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
  const replayedReply = history.value.events.find(
    (event) =>
      event.kind === "agent_message" &&
      event.replayed &&
      event.content.some((content) => content.text.includes("remember me")),
  );
  expect(replayedReply).toBeDefined();
}, 20000);

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

test("process exit during a prompt yields unknown/failure, never success", async () => {
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
  if (observed.value.kind !== "failed") return;
  expect(observed.value.failure_code).toBe("acp_transport_lost");
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

test("operator input whose touch fails is never queued for a later dispatch", async () => {
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

  const sent = await broken.service.sendInput(sid, "doomed operator input");
  expect(sent.ok).toBe(false);
  // §11.3: the operator was told it failed, so the turn must not sit
  // accepted and dispatch on some later successful touch.
  expect(broken.store.listAcceptedTurns(sid as KbblSessionId)).toHaveLength(0);
  const doomedTurn = broken.db
    .prepare<{ status: string }, [string]>(
      "SELECT status FROM acp_turns WHERE sid = ? AND source = 'operator'",
    )
    .get(sid);
  expect(doomedTurn?.status).toBe("failed");

  // Restart onto a working binary: the touch must find nothing to dispatch.
  await broken.service.shutdown();
  const healthy = makeHarness({ stateDir, db: first.db });
  healthy.service.recoverOnBoot();
  const history = await healthy.service.loadHistory(sid);
  expect(history.ok && !history.value.expired).toBe(true);
  await new Promise((resolve) => setTimeout(resolve, 300));
  const afterTouch = healthy.db
    .prepare<{ status: string }, [string]>(
      "SELECT status FROM acp_turns WHERE sid = ? AND source = 'operator'",
    )
    .get(sid);
  expect(afterTouch?.status).toBe("failed");
  const reloaded = await healthy.service.loadHistory(sid);
  expect(reloaded.ok).toBe(true);
  if (!reloaded.ok) return;
  const doomedEvent = reloaded.value.events.find(
    (event) =>
      "content" in event &&
      Array.isArray(event.content) &&
      event.content.some((content) => content.text.includes("doomed")),
  );
  expect(doomedEvent).toBeUndefined();
}, 25000);

test("operator retry with the same client_message_id returns the stored receipt even while that turn is prompting", async () => {
  const { stateDir, workdir } = await makeDirs();
  const harness = makeHarness({ behavior: "delayed", stateDir, delayMs: 5000 });
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

  // §14.5: a retry of the SAME message is answered with its receipt, not
  // session_busy — the busy guard refuses only new operator input.
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
  expect(!newInput.ok && newInput.error.code).toBe("session_busy");
}, 20000);
