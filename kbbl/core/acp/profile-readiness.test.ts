import { expect, test } from "bun:test";
import { readProfileReadiness } from "./profile-readiness";
import type { AgentProfile } from "./agent-profile";
const profile: AgentProfile = { id: "custom", label: "Custom", enabled: true, command: "/bin/sh", args: [], env_policy: { inherit: true }, requireLoadSession: true, sessionMode: null, skillDiscovery: { kind: "additionalDirectories" }, auth_probe: { command: ["example", "auth", "status"], fix: "Authenticate the example CLI" } };
test("authenticated CLI with runtime and skill support is ready", async () => {
  expect((await readProfileReadiness(profile, async (command) => command.join(" ") === "example auth status")).readiness.kind).toBe("ok");
});
test("expired login is an actionable optional profile failure", async () => {
  expect((await readProfileReadiness(profile, async () => false)).readiness).toEqual({ kind: "failed", detail: "Agent CLI authentication is unavailable or expired", fix: "Authenticate the example CLI" });
});
test("a profile without an auth probe reports optional unavailability", async () => {
  expect((await readProfileReadiness({ ...profile, auth_probe: undefined }, async () => { throw new Error("unexpected probe"); })).readiness.kind).toBe("unavailable_optional");
});
test("disabled profile remains in the read model without probing", async () => {
  expect(await readProfileReadiness({ ...profile, enabled: false }, async () => { throw new Error("must not probe"); })).toMatchObject({ enabled: false, readiness: { kind: "unavailable_optional" } });
});
test("missing adapter and missing skill discovery have distinct fixes", async () => {
  expect((await readProfileReadiness({ ...profile, command: "/nonexistent/adapter" })).readiness).toMatchObject({ kind: "failed", detail: "ACP adapter executable is missing" });
  expect((await readProfileReadiness({ ...profile, skillDiscovery: null })).readiness).toMatchObject({ kind: "failed", detail: "Profile has no session skill discovery support" });
});

import { sharedProfileReadiness } from "./profile-readiness";
test("concurrent polls share one probe and cached results expire", async () => {
  let calls = 0;
  let time = 0;
  let release: (() => void) | undefined;
  const pending = new Promise<void>((resolve) => { release = resolve; });
  const read = sharedProfileReadiness({ read: async () => { calls++; await pending; return []; }, now: () => time, cache_ms: 10 });
  const polls = Array.from({ length: 20 }, () => read());
  await Promise.resolve();
  expect(calls).toBe(1);
  if (!release) throw new Error("missing probe release");
  release();
  await Promise.all(polls);
  await read();
  expect(calls).toBe(1);
  time = 11;
  await read();
  expect(calls).toBe(2);
});
test("a failed shared probe is retried without caching the failure", async () => {
  let calls = 0;
  const read = sharedProfileReadiness({ read: async () => { if (++calls === 1) throw new Error("probe failed"); return []; } });
  await expect(read()).rejects.toThrow("probe failed");
  expect(await read()).toEqual([]);
});
