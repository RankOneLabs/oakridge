import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";
import type { ProviderResult, TerminalObservation } from "../src/effects/provider";
import type { EffectPayload } from "../src/effects/intents";
import { begin, sessionBundle, waitUntil, withDatabase } from "./effect-fixture";

interface RejectionCase { readonly name: string; readonly observations: readonly ProviderResult<unknown>[] }
const cases: readonly RejectionCase[] = [
  { name: "unavailable observations reach the configured bound", observations: [
    { kind: "transiently_unavailable", detail: "kbbl offline" },
    { kind: "transiently_unavailable", detail: "kbbl offline" },
  ] },
  { name: "running resets the consecutive unavailable count", observations: [
    { kind: "transiently_unavailable", detail: "kbbl offline" },
    { kind: "acknowledged", value: { kind: "running" } },
    { kind: "transiently_unavailable", detail: "kbbl offline" },
    { kind: "transiently_unavailable", detail: "kbbl offline" },
  ] },
  { name: "malformed terminal observations reject", observations: [
    { kind: "acknowledged", value: { kind: "terminal", result: null } },
  ] },
  { name: "permanent rejections without provider evidence reject", observations: [
    { kind: "permanently_rejected", code: "invalid_invocation", detail: "invalid observation" },
  ] },
];

for (const rejection of cases) test(`${rejection.name}, fail the scope, and discharge cleanup`, async () => withDatabase(async ({ url, db }) => {
  let observations = 0;
  let can_confirm_stop = false;
  const composition = await createProductionComposition({ database_url: url,
    core_binary: resolve(import.meta.dir, "../../workflow-core/target/debug/workflow-cli"), host: "127.0.0.1",
    timing: { retry_initial_seconds: 0.01, retry_cap_seconds: 0.02, observe_interval_seconds: 0.01,
      max_observe_unavailable_attempts: 2, wake_timeout_seconds: 0.02 },
    effect_provider: {
      start: async () => ({ kind: "acknowledged", value: { kind: "kbbl_session", session_id: "session" } }),
      // A malformed provider response deliberately crosses the typed IO boundary.
      observe: async () => rejection.observations[Math.min(observations++, rejection.observations.length - 1)] as ProviderResult<TerminalObservation>,
      stop: async () => can_confirm_stop ? { kind: "acknowledged", value: { stopped: true } }
        : { kind: "uncertain", detail: "cleanup unavailable" },
    } });
  try {
    const run = await begin(composition, await sessionBundle(), { runtime: "claude-code", rendered_prompt: "publish", workdir: "/tmp", session_name: "rejected",
      session_identity: {}, worktree: { branchName: "selected", worktreeSubdir: "selected" } });
    await waitUntil(async () => (await db.query<{ is_terminal: boolean }>(
      "SELECT is_terminal FROM authority.scope_instance WHERE id=$1", [run.root_scope_id]))[0]?.is_terminal === true);
    await waitUntil(async () => (await db.query<{ payload: EffectPayload }>(
      "SELECT payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0]?.payload.evidence_delivered === true);
    expect(observations).toBe(rejection.observations.length);
    const start = (await db.query<{ status: string; payload: EffectPayload }>(
      "SELECT status,payload FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='start'", [run.root_scope_id]))[0];
    expect(start).toMatchObject({ status: "rejected", payload: { evidence: { key: "session_failed" }, evidence_delivered: true } });
    expect((await db.query<{ count: string }>(
      "SELECT count(*)::text AS count FROM authority.fact WHERE scope_id=$1 AND fact_key='session_failed'", [run.root_scope_id]))[0]?.count).toBe("1");
    expect((await composition.app.request(`/runs/${run.run_id}`, { method: "DELETE" })).status).toBe(409);
    can_confirm_stop = true;
    await waitUntil(async () => (await db.query<{ status: string }>(
      "SELECT status FROM authority.effect_intent WHERE scope_id=$1 AND payload->>'action'='stop'", [run.root_scope_id]))[0]?.status === "cleanup_confirmed");
    expect((await composition.app.request(`/runs/${run.run_id}`, { method: "DELETE" })).status).toBe(200);
  } finally { can_confirm_stop = true; await composition.close(); }
}));
