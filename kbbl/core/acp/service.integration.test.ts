import { afterEach, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperatorPrIntegration as PrIntegration } from "../pwa/oakridge/operator-contracts/domain/pr-integration";
import { makeAcpTestService, type AcpTestHarness, type AcpTestHarnessOptions } from "./test-harness";
import type { AcpSessionStartSpec } from "./types";

const harnesses: AcpTestHarness[] = [];
const directories: string[] = [];
afterEach(async () => {
  for (const harness of harnesses.splice(0)) await harness.service.shutdown();
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true });
});
function makeHarness(options: AcpTestHarnessOptions): AcpTestHarness {
  const harness = makeAcpTestService({ ...options, profileIds: ["fake"], defaultAgent: "fake", skillDiscovery: { kind: "additionalDirectories" } });
  harnesses.push(harness);
  return harness;
}
async function makeDirs(): Promise<{ stateDir: string; workdir: string }> {
  const stateDir = await mkdtemp(join(tmpdir(), "session-integration-state-"));
  const workdir = await mkdtemp(join(tmpdir(), "session-integration-work-"));
  directories.push(stateDir, workdir);
  return { stateDir, workdir };
}
function spec(workdir: string, initial_prompt = "build the thing"): AcpSessionStartSpec {
  return { initial_prompt, workdir, runtime: "fake" };
}

const GATED_REVIEW_URL = "http://127.0.0.1:3555/mcp/";
const GATED_REVIEW_SERVERS = [{ type: "http", name: "gated-review", url: GATED_REVIEW_URL, headers: [] }];

async function readRecordedServers(stateDir: string, agentSessionId: string, setup: "mcp-servers" | "load-mcp-servers"): Promise<unknown> {
  return JSON.parse(await readFile(join(stateDir, `${agentSessionId}.${setup}.json`), "utf8"));
}

function integrationConfig(stateDir: string, integration: PrIntegration = "none") {
  return { default_integration: integration, gated_review_url: GATED_REVIEW_URL,
    skill_store_root: join(import.meta.dir, "../../../workflow-config/definitions/skills"), session_skills_root: join(stateDir, "session-skills") };
}
test("a gated-review session resumes with its recorded MCP server and skill", async () => {
  const { stateDir, workdir } = await makeDirs();
  const integration = integrationConfig(stateDir);
  const first = makeHarness({ stateDir, integration });
  const identity = { run_id: "run-1", unit_id: "run-1/planning", worker: "planner", pr_integration: "gated-review" as const, pr_skill_digest: "8199a2589e1e69ded71370f990e7ac3e9ac48d6dc2137bad004d507de0b7280c" };
  const ensured = await first.service.ensureResumableSession("resume-wiring", spec(workdir), identity);
  if (!ensured.ok) throw new Error(ensured.error.detail);
  const sid = ensured.value.session.sid;
  await first.service.observeInitialTurn(sid, 8000);
  await first.service.shutdown();
  const second = makeHarness({ stateDir, db: first.db, integration });
  second.service.recoverOnBoot();
  expect((await second.service.loadHistory(sid)).ok).toBe(true);
  const agentSessionId = second.store.getSession(sid)?.acp_session_id;
  if (!agentSessionId) throw new Error("agent session missing");
  expect(await readRecordedServers(stateDir, agentSessionId, "load-mcp-servers")).toEqual(GATED_REVIEW_SERVERS);
  const roots = JSON.parse(await readFile(join(stateDir, `${agentSessionId}.additional-directories.json`), "utf8"));
  expect(roots).toContain(join(stateDir, "session-skills", sid));
  expect(second.store.getSession(sid)?.workflow).toEqual(identity);
}, 20000);

test("direct github-cli uses the current pinned skill and no MCP server", async () => {
  const previousMarker = process.env.KBBL_TEST_AUTH_MARKER;
  process.env.KBBL_TEST_AUTH_MARKER = "inherited-login-environment";
  try {
    const { stateDir, workdir } = await makeDirs();
    const { service, store } = makeHarness({ stateDir, integration: integrationConfig(stateDir, "github-cli") });
    const created = await service.createSession(spec(workdir));
    if (!created.ok) throw new Error(created.error.detail);
    const row = store.getSession(created.value.sid);
    if (!row?.acp_session_id) throw new Error("agent session missing");
    expect(await readRecordedServers(stateDir, row.acp_session_id, "mcp-servers")).toEqual([]);
    const skill = await readFile(join(stateDir, "session-skills", row.sid, ".agents/skills/pr-operations/SKILL.md"), "utf8");
    expect(skill).toContain("gh pr create");
    expect(row.pr_skill_digest).toBe(JSON.parse(await readFile(join(import.meta.dir, "../../../workflow-config/definitions/skills.json"), "utf8"))["github-cli"]);
    expect(JSON.parse(await readFile(join(stateDir, `${row.acp_session_id}.auth-marker.json`), "utf8"))).toBe("inherited-login-environment");
  } finally {
    if (previousMarker === undefined) delete process.env.KBBL_TEST_AUTH_MARKER;
    else process.env.KBBL_TEST_AUTH_MARKER = previousMarker;
  }
});

test("direct none gets neither a skill directory nor an MCP server", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service, store } = makeHarness({ stateDir, integration: integrationConfig(stateDir) });
  const created = await service.createSession(spec(workdir));
  if (!created.ok) throw new Error(created.error.detail);
  const row = store.getSession(created.value.sid);
  if (!row?.acp_session_id) throw new Error("agent session missing");
  expect(await readRecordedServers(stateDir, row.acp_session_id, "mcp-servers")).toEqual([]);
  expect(await Bun.file(join(stateDir, "session-skills", row.sid, ".agents/skills/pr-operations/SKILL.md")).exists()).toBe(false);
});


test("purging a session removes its materialized skill directory", async () => {
  const { stateDir, workdir } = await makeDirs();
  const { service } = makeHarness({ stateDir, integration: integrationConfig(stateDir, "github-cli") });
  const created = await service.createSession(spec(workdir));
  if (!created.ok) throw new Error(created.error.detail);
  const skillDirectory = join(stateDir, "session-skills", created.value.sid);
  expect(await Bun.file(join(skillDirectory, ".agents/skills/pr-operations/SKILL.md")).exists()).toBe(true);
  await service.purgeSession(created.value.sid);
  expect(existsSync(skillDirectory)).toBe(false);
});


test("start spec hash changes when only the pinned skill digest changes", async () => {
  const { startSpecHash } = await import("./start-spec-hash");
  expect(startSpecHash(spec("/work"), { pr_integration: "github-cli", pr_skill_digest: "a".repeat(64) }))
    .not.toBe(startSpecHash(spec("/work"), { pr_integration: "github-cli", pr_skill_digest: "b".repeat(64) }));
});

for (const change of ["default-changed", "index-advanced", "index-missing"] as const) {
  test(`direct resumable retry retains its saved pin when ${change}`, async () => {
    const { cpSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } = await import("node:fs");
    const { stateDir, workdir } = await makeDirs();
    const original = integrationConfig(stateDir, "github-cli");
    const storeRoot = join(stateDir, "store");
    mkdirSync(storeRoot);
    const skillStoreRoot = join(storeRoot, "skills");
    cpSync(original.skill_store_root, skillStoreRoot, { recursive: true });
    const indexPath = join(storeRoot, "skills.json");
    cpSync(join(original.skill_store_root, "../skills.json"), indexPath);
    const integration = { ...original, skill_store_root: skillStoreRoot };
    const first = makeHarness({ stateDir, integration });
    const start = spec(workdir);
    const created = await first.service.ensureResumableSession("direct-pin", start);
    if (!created.ok) throw new Error(created.error.detail);
    const sid = created.value.session.sid;
    await first.service.observeInitialTurn(sid, 8000);
    const pinned = first.store.getSession(sid);
    if (!pinned) throw new Error("saved session missing");
    await first.service.shutdown();

    if (change === "index-advanced") {
      const index = JSON.parse(readFileSync(indexPath, "utf8")) as { "github-cli": string; "gated-review": string };
      writeFileSync(indexPath, JSON.stringify({ ...index, "github-cli": index["gated-review"] }));
    }
    if (change === "index-missing") unlinkSync(indexPath);
    const second = makeHarness({ stateDir, db: first.db, integration: {
      ...integration, default_integration: change === "default-changed" ? "none" : "github-cli",
    } });
    second.service.recoverOnBoot();
    const attached = await second.service.ensureResumableSession("direct-pin", start);
    expect(attached).toMatchObject({ ok: true, value: { kind: "existing", session: { sid } } });
    expect(second.store.getSession(sid)?.pr_skill_digest).toBe(pinned.pr_skill_digest);
    expect(second.store.getSession(sid)?.pr_integration).toBe("github-cli");
    const changedSpec = await second.service.ensureResumableSession("direct-pin", { ...start, initial_prompt: "different instruction" });
    expect(changedSpec.ok ? null : changedSpec.error.code).toBe("session_key_conflict");
    const explicitSwitch = await second.service.ensureResumableSession("direct-pin", start, {
      run_id: "run", unit_id: "unit", worker: "builder", pr_integration: "none", pr_skill_digest: null,
    });
    expect(explicitSwitch.ok ? null : explicitSwitch.error.code).toBe("session_key_conflict");
  });
}

test("scripted Claude responses and cost snapshots survive controller turns", async () => {
  const { stateDir, workdir } = await makeDirs();
  const usage = { inputTokens: 10, outputTokens: 5, cachedReadTokens: 4, cachedWriteTokens: 3, totalTokens: 22 };
  const quota = { token_count: {}, model_usage: [{ model: "claude", token_count: {
    inputTokens: 10, outputTokens: 5, cachedInputTokens: 4, cachedWriteTokens: 3, totalTokens: 22,
  } }] };
  await Bun.write(join(stateDir, "usage-script.json"), JSON.stringify([
    { response: { usage, _meta: { quota } }, updates: [
      { used: 50, size: 100 },
      { used: 60, size: 100, cost: { amount: 2.5, currency: "USD" }, _meta: { "_claude/origin": { kind: "peer" } } },
    ] },
    { response: {} },
    { response: { _meta: { quota: { unexpected: true } } } },
  ]));
  const harness = makeAcpTestService({ stateDir, profileIds: ["claude-code"] });
  harnesses.push(harness);
  const ensured = await harness.service.ensureResumableSession("usage-script", { initial_prompt: "hi", workdir, runtime: "claude-code" });
  if (!ensured.ok) throw Error(ensured.error.detail);
  const sid = ensured.value.session.sid;
  await harness.service.observeInitialTurn(sid, 8000);
  for (const key of ["absent", "partial"]) {
    const sent = await harness.service.sendInput(sid, "hi", { client_message_id: key });
    if (!sent.ok) throw Error(sent.error.detail);
    const deadline = Date.now() + 8000;
    while (["accepted", "prompting"].includes(harness.store.getTurn(sid, sent.value.turn_key)?.status ?? "")) {
      if (Date.now() > deadline) throw Error("turn timed out");
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  }
  const result = harness.store.readUsage(sid);
  expect(result.turns.map(t => [t.status, t.usage?.status])).toEqual([
    ["succeeded", "reported"], ["succeeded", "absent"], ["succeeded", "partial"],
  ]);
  expect(result.turns[0]?.usage?.input_tokens).toBe(10);
  expect(result.turns[2]?.usage?.raw_json).toContain("unexpected");
  expect(result.readings).toHaveLength(1);
  expect(result.readings[0]).toMatchObject({
    process_seq: 0, active_turn_key: result.turns[0]?.turn_key, autonomous: true, origin_kind: "peer", cost_amount: 2.5,
  });
  expect(harness.registry.getLive(sid)?.snapshotEvents().some(event => event.kind === "usage")).toBe(true);
}, 20000);
