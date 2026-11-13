import { describe, expect, spyOn, test } from "bun:test";
import { Hono } from "hono";
import { AcpSessionStore } from "../../acp/store";
import type { KbblSessionId, TurnKey } from "../../acp/types";
import { openTestDb } from "../../db/test-db";
import type { RetainedPromptTurn } from "../../acp/store-turns";
import { mountExecutedPromptRoutes, redactPublicationSecret } from "./executed-prompt";

const secret = "publication-test-secret+$";
const preamble: RetainedPromptTurn = { turn_id: "preamble" as TurnKey, created_at: "2026-01-01", started_at: "2026-01-01", text: `Worker instructions\nYour publication secret: ${secret}\nPublish using ${secret}` };
const task: RetainedPromptTurn = { turn_id: "task" as TurnKey, created_at: "2026-01-02", started_at: "2026-01-02", text: `Shared task\nAuthorization: Bearer ${secret}\nAgain ${secret}` };
const turns = [preamble, task];
const path = "/oakridge/sessions/session-1/executed-prompt";
const operator = { authorization: "Bearer control-test" };
function mounted(readPromptTurns: () => readonly RetainedPromptTurn[] | null) {
  const app = new Hono();
  mountExecutedPromptRoutes(app, { acp: { readPromptTurns }, browserControlToken: "control-test" });
  return app;
}

describe("session-wide publication secret redaction", () => {
  test("redacts the preamble and all later shared-session occurrences without dropping content", () => {
    const result = redactPublicationSecret(turns);
    expect(result).toEqual([
      { ...turns[0], text: "Worker instructions\nYour publication secret: [redacted]\nPublish using [redacted]" },
      { ...turns[1], text: "Shared task\nAuthorization: Bearer [redacted]\nAgain [redacted]" },
    ]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(turns[0]?.text).toContain(secret);
  });
  test("redacts bearer tokens and their other occurrences with no retained preamble", () => {
    expect(redactPublicationSecret([task])[0]?.text).toBe("Shared task\nAuthorization: Bearer [redacted]\nAgain [redacted]");
  });
  test("captures multiple preambles and CRLF without changing ordinary content", () => {
    const result = redactPublicationSecret([{ ...preamble, text: "Your publication secret: first-secret\r\nYour publication secret: second-secret\r\nfirst-secret second-secret ordinary" }]);
    expect(result[0]?.text).toBe("Your publication secret: [redacted]\r\nYour publication secret: [redacted]\r\n[redacted] [redacted] ordinary");
  });
});

test("GET authenticates before reading retained payloads", async () => {
  let reads = 0;
  const app = mounted(() => { reads += 1; return turns; });
  expect((await app.request(path)).status).toBe(401);
  expect((await app.request(path, { headers: { authorization: "Bearer wrong" } })).status).toBe(401);
  expect(reads).toBe(0);
  expect((await app.request(path, { headers: { cookie: "kbbl_ctrl=control-test" } })).status).toBe(200);
});
test("GET serializes only redacted turns and never logs payloads, even on IO failure", async () => {
  const logs = [spyOn(console, "log"), spyOn(console, "error"), spyOn(console, "warn")];
  try {
    const response = await mounted(() => turns).request(path, { headers: operator });
    const text = await response.text();
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(text).not.toContain(secret);
    expect(text).not.toContain(`Your publication secret: ${secret}`);
    expect(text).toContain("Your publication secret: [redacted]");
    expect(text).toContain("Authorization: Bearer [redacted]");
    const failure = await mounted(() => { throw new Error(turns[0]?.text); }).request(path, { headers: operator });
    expect(failure.status).toBe(503);
    expect(await failure.text()).not.toContain("Worker instructions");
    expect(logs.flatMap((log) => log.mock.calls)).toEqual([]);
  } finally { logs.forEach((log) => log.mockRestore()); }
});
test("GET captures queued preamble credentials before excluding never-dispatched content", async () => {
  const response = await mounted(() => [{ ...preamble, started_at: null }, { ...task, text: `Dispatched instructions using ${secret}` }]).request(path, { headers: operator });
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual([{ turn_id: task.turn_id, created_at: task.created_at, text: "Dispatched instructions using [redacted]" }]);
});
test("GET does not call accepted turns executed", async () => {
  const response = await mounted(() => [{ ...preamble, started_at: null }]).request(path, { headers: operator });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "not_retained" } });
});
test("GET omits queued and undispatched cancelled turns but retains uncertain dispatched turns", async () => {
  const db = openTestDb();
  try {
    const store = new AcpSessionStore(db);
    const sid = "session-1" as KbblSessionId;
    store.insertSession({ sid, resumable_key: null, start_spec_hash: null, agent_profile: "fake", name: "test", artifact_id: null, project_workdir: "/tmp", worktree_path: "/tmp", requested_model: null, requested_effort: null, requested_mode: null, workflow: null });
    store.acceptTurn({ sid, turn_key: preamble.turn_id, source: "initial", payload: preamble.text });
    const cancelled = "cancelled" as TurnKey;
    store.acceptTurn({ sid, turn_key: cancelled, source: "operator", payload: "Never dispatched cancelled content" });
    store.completeTurn(sid, cancelled, { status: "cancelled" });
    store.acceptTurn({ sid, turn_key: task.turn_id, source: "operator", payload: `Uncertain delivery using ${secret}` });
    store.markTurnPrompting(sid, task.turn_id);
    store.completeTurn(sid, task.turn_id, { status: "unknown" });
    const response = await mounted(() => store.readPromptTurns(sid)).request(path, { headers: operator });
    expect(response.status).toBe(200);
    const content = await response.text();
    expect(JSON.parse(content)).toEqual([{ turn_id: task.turn_id, created_at: store.getTurn(sid, task.turn_id)?.created_at, text: "Uncertain delivery using [redacted]" }]);
    expect(content).not.toContain(secret);
    expect(content).not.toContain("Never dispatched");
  } finally { db.close(); }
});
test.each(["session", "turns"])("absent %s returns not_retained", async (missing) => {
  const response = await mounted(() => missing === "session" ? null : []).request(path, { headers: operator });
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({ error: { code: "not_retained" } });
});
test("store reads retained payloads in creation order, including tied timestamps", () => {
  const db = openTestDb();
  try {
    const store = new AcpSessionStore(db);
    const sid = "session-1" as KbblSessionId;
    expect(store.readPromptTurns(sid)).toBeNull();
    store.insertSession({ sid, resumable_key: null, start_spec_hash: null, agent_profile: "fake", name: "test", artifact_id: null, project_workdir: "/tmp", worktree_path: "/tmp", requested_model: null, requested_effort: null, requested_mode: null, workflow: null });
    expect(store.readPromptTurns(sid)).toBeNull();
    for (const turn of turns) store.acceptTurn({ sid, turn_key: turn.turn_id as TurnKey, source: "operator", payload: turn.text });
    db.prepare("UPDATE acp_turns SET created_at = ?").run("same-time");
    expect(store.readPromptTurns(sid)?.map(({ turn_id, text }) => ({ turn_id, text }))).toEqual(turns.map(({ turn_id, text }) => ({ turn_id, text })));
  } finally { db.close(); }
});
