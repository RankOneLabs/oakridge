import { expect, test } from "bun:test";
import { readProfileReadiness } from "./profile-readiness";
import type { AgentProfile } from "./agent-profile";
const profile: AgentProfile = { id: "codex", label: "Codex", enabled: true, command: "/bin/sh", args: [], env_policy: { inherit: true }, requireLoadSession: true, sessionMode: null, skillDiscovery: { kind: "additionalDirectories" } };
test("authenticated CLI with runtime and skill support is ready", async () => {
  expect((await readProfileReadiness(profile, async (command) => command.slice(-2).join(" ") === "login status")).readiness.kind).toBe("ok");
});
test("expired login is an actionable optional profile failure", async () => {
  expect((await readProfileReadiness(profile, async () => false)).readiness).toEqual({ kind: "failed", detail: "Agent CLI authentication is unavailable or expired", fix: "Run codex login" });
});
test("disabled profile remains in the read model without probing", async () => {
  expect(await readProfileReadiness({ ...profile, enabled: false }, async () => { throw new Error("must not probe"); })).toMatchObject({ enabled: false, readiness: { kind: "unavailable_optional" } });
});
test("missing adapter and missing skill discovery have distinct fixes", async () => {
  expect((await readProfileReadiness({ ...profile, command: "/nonexistent/adapter" })).readiness).toMatchObject({ kind: "failed", detail: "ACP adapter executable is missing" });
  expect((await readProfileReadiness({ ...profile, skillDiscovery: null })).readiness).toMatchObject({ kind: "failed", detail: "Profile has no session skill discovery support" });
});
