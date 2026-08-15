import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { FilesystemResumableInputInbox, FilesystemResumableSessionClaims, ResumableInputConflictError, SessionKeyConflictError, sessionIdForKey, type ResumableInputDeliveryKey, type ResumableSessionKey } from "./resumable-session";

const startSpec = { initial_prompt: "Build the thing", workdir: "/repo", runtime: "claude-code" as const };

test("concurrent claims for one execution return one stable session identity", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbbl-session-claim-"));
  const store = new FilesystemResumableSessionClaims(dir);
  const key = "execution-1:executor-step" as ResumableSessionKey;
  const claims = await Promise.all(Array.from({ length: 20 }, () => store.claim(key, startSpec)));
  expect(claims.filter((item) => item.is_new)).toHaveLength(1);
  expect(new Set(claims.map((item) => item.claim.session_id))).toEqual(new Set([sessionIdForKey(key)]));
});

test("a retry may not change the immutable start specification", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbbl-session-claim-"));
  const store = new FilesystemResumableSessionClaims(dir);
  const key = "execution-2:executor-step" as ResumableSessionKey;
  await store.claim(key, startSpec);
  expect(store.claim(key, { ...startSpec, initial_prompt: "Different work" })).rejects.toBeInstanceOf(SessionKeyConflictError);
});

test("resumable input acceptance survives store reconstruction and returns one receipt", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbbl-input-inbox-"));
  const key = "execution-1:revision-1" as ResumableInputDeliveryKey;
  const firstStore = new FilesystemResumableInputInbox(dir);
  const queued = await firstStore.enqueue(key, "Revise this output");
  const delivered = await firstStore.markDelivered(queued);
  const retry = await new FilesystemResumableInputInbox(dir).enqueue(key, "Revise this output");
  expect(delivered.status).toBe("delivered");
  expect(retry).toEqual(delivered);
});

test("resumable input rejects delivery-key reuse with different text", async () => {
  const dir = await mkdtemp(join(tmpdir(), "kbbl-input-inbox-"));
  const store = new FilesystemResumableInputInbox(dir);
  const key = "execution-2:revision-1" as ResumableInputDeliveryKey;
  await store.enqueue(key, "First revision request");
  expect(store.enqueue(key, "Different revision request")).rejects.toBeInstanceOf(ResumableInputConflictError);
});
