import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { KbblConfigSchema, type KbblConfig } from "../config";
import { SessionManager } from "./session-manager";
import type { Session, SpawnCmd, SessionSnapshot } from "./session";

let tmpRoot: string;
let sessionsDir: string;
let worktreesDir: string;

function buildConfig(): KbblConfig {
  return KbblConfigSchema.parse({});
}

async function noopSpawn(_session: Session): Promise<SpawnCmd> {
  return { cmd: ["true"], cwd: "/tmp", env: {} };
}

function makeManager(config: KbblConfig): SessionManager {
  return new SessionManager({
    sessionsDir,
    handoffsDir: join(tmpRoot, "handoffs"),
    worktreesDir,
    buildSpawnCmd: noopSpawn,
    config,
  });
}

function writeJsonl(sid: string, lines: object[]): void {
  const path = join(sessionsDir, `${sid}.jsonl`);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
}

async function loadSnapshot(
  mgr: SessionManager,
  sid: string,
): Promise<SessionSnapshot | undefined> {
  const all = await mgr.listArchivedSnapshots();
  return all.find((s) => s.sid === sid);
}

const baseTs = "2026-05-23T17:52:29.606Z";

function sessionStarted(id: number): object {
  return {
    id,
    type: "session_started",
    ts: baseTs,
    payload: {
      command: ["claude"],
      workdir: "/tmp",
      name: "test",
      sessionId: "ignored",
      parentCcSid: null,
      parentOakridgeSid: null,
      artifactId: null,
      worktreePath: null,
      worktreeBranch: null,
      worktreeBaseRef: null,
      projectWorkdir: null,
      model: null,
    },
  };
}

beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-observed-model-test-"));
  sessionsDir = join(tmpRoot, "sessions");
  worktreesDir = join(tmpRoot, "worktrees");
  mkdirSync(sessionsDir, { recursive: true });
  mkdirSync(worktreesDir, { recursive: true });
  mkdirSync(join(tmpRoot, "handoffs"), { recursive: true });
});

afterEach(() => {
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("loadArchivedSnapshot observedModel reconstruction", () => {
  test("uses the last model_observed event when present", async () => {
    const sid = "11111111-1111-1111-1111-111111111111";
    writeJsonl(sid, [
      sessionStarted(0),
      {
        id: 1,
        type: "model_observed",
        ts: baseTs,
        payload: { model: "claude-opus-4-7" },
      },
      {
        id: 2,
        type: "model_observed",
        ts: baseTs,
        payload: { model: "claude-haiku-4-5" },
      },
    ]);

    const mgr = makeManager(buildConfig());
    const snap = await loadSnapshot(mgr, sid);
    expect(snap?.initialObservedModel).toBe("claude-opus-4-7");
    expect(snap?.observedModel).toBe("claude-haiku-4-5");
  });

  test("back-compat: reconstructs from system+init + assistant when no model_observed events exist", async () => {
    const sid = "22222222-2222-2222-2222-222222222222";
    writeJsonl(sid, [
      sessionStarted(0),
      {
        id: 1,
        type: "system",
        ts: baseTs,
        payload: {
          type: "system",
          subtype: "init",
          session_id: "cc-sid",
          model: "claude-opus-4-7",
        },
      },
      {
        id: 2,
        type: "assistant",
        ts: baseTs,
        payload: {
          type: "assistant",
          message: { model: "claude-opus-4-7" },
        },
      },
      {
        id: 3,
        type: "assistant",
        ts: baseTs,
        payload: {
          type: "assistant",
          message: { model: "claude-haiku-4-5" },
        },
      },
    ]);

    const mgr = makeManager(buildConfig());
    const snap = await loadSnapshot(mgr, sid);
    expect(snap?.initialObservedModel).toBe("claude-opus-4-7");
    expect(snap?.observedModel).toBe("claude-haiku-4-5");
  });

  test("returns null when neither model_observed nor system+init/assistant carry a model", async () => {
    const sid = "33333333-3333-3333-3333-333333333333";
    writeJsonl(sid, [
      sessionStarted(0),
      {
        id: 1,
        type: "system",
        ts: baseTs,
        payload: { type: "system", subtype: "init", session_id: "cc-sid" },
      },
    ]);

    const mgr = makeManager(buildConfig());
    const snap = await loadSnapshot(mgr, sid);
    expect(snap?.initialObservedModel).toBeNull();
    expect(snap?.observedModel).toBeNull();
  });

  test("does not gate observedModel by isAllowedModel; preserves date-suffixed snapshot ids", async () => {
    const sid = "44444444-4444-4444-4444-444444444444";
    writeJsonl(sid, [
      sessionStarted(0),
      {
        id: 1,
        type: "model_observed",
        ts: baseTs,
        payload: { model: "claude-future-snapshot-20991231" },
      },
    ]);

    const mgr = makeManager(buildConfig());
    const snap = await loadSnapshot(mgr, sid);
    expect(snap?.initialObservedModel).toBe("claude-future-snapshot-20991231");
    expect(snap?.observedModel).toBe("claude-future-snapshot-20991231");
  });
});
