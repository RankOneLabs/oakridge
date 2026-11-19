import { expect, test } from "bun:test";
import { assembleInstallStatus, selectAccessMode, selectInstallationFailed, type InstallCheck } from "../src/projections/install-status-view";

for (const bind_host of ["127.0.0.1", "::1", "localhost", "[::1]"]) {
  for (const has_control_token of [false, true]) {
    test(`loopback ${bind_host} is local with token presence ${has_control_token}`, () => {
      expect(selectAccessMode({ bind_host, has_control_token, allow_insecure_non_loopback: false })).toEqual({ kind: "local", bind_host });
    });
  }
}
test("network with token is authenticated", () => {
  expect(selectAccessMode({ bind_host: "0.0.0.0", has_control_token: true, allow_insecure_non_loopback: false }).kind).toBe("authenticated_network");
});
test("explicit override allows insecure network", () => {
  expect(selectAccessMode({ bind_host: "0.0.0.0", has_control_token: false, allow_insecure_non_loopback: true }).kind).toBe("insecure_network");
});
test("refused network has a required failure with both remedies", () => {
  const result = selectAccessMode({ bind_host: "0.0.0.0", has_control_token: false, allow_insecure_non_loopback: false });
  expect(result).toMatchObject({ kind: "failed", required: true });
  if (result.kind !== "failed") throw new Error("expected refusal");
  expect(result.fix).toContain("OAKRIDGE_CONTROL_TOKEN");
  expect(result.fix).toContain("ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1");
});
const optional: InstallCheck = { kind: "unavailable_optional", id: "integration", label: "PR integration", required: false, detail: "Not selected", fix: "Select an integration" };
const unauthenticated: InstallCheck = { kind: "failed", id: "agent", label: "Agent", required: false, detail: "Not authenticated", fix: "Authenticate the CLI" };
test("optional absence and optional failure do not fail installation", () => {
  expect(selectInstallationFailed([optional, unauthenticated])).toBe(false);
});
test("required failure fails installation", () => {
  expect(selectInstallationFailed([{ ...unauthenticated, required: true }])).toBe(true);
});
test("assembled model carries presence only, never the token", () => {
  const token = "secret-status-test-token";
  const access_mode = selectAccessMode({ bind_host: "0.0.0.0", has_control_token: Boolean(token), allow_insecure_non_loopback: false });
  if (access_mode.kind === "failed") throw new Error("unexpected refusal");
  const status = assembleInstallStatus({ access_mode, checks: [], agent_profiles: [], pr_integration: { selected: "none", health: optional }, observation: { availability: optional }, launch_blocks: [] });
  expect(status.installation_failed).toBe(false);
  expect(JSON.stringify(status)).not.toContain(token);
});

import { Hono } from "hono";
import { installStatusRoute, readInstallStatus, type InstallStatusDependencies } from "../src/http/install-status";
import { readLaunchableCatalog, resolveDefinition, type ResolvedDefinition } from "../src/runtime/definition-store";
function definitions(): readonly ResolvedDefinition[] {
  const catalog = readLaunchableCatalog();
  if (!catalog.ok) throw new Error("catalog unavailable");
  return ["development", "review-loop", "fan-out"].map((name) => {
    const definition = resolveDefinition(catalog.value[name].definition_id);
    if (!definition.ok) throw new Error("fixture unavailable");
    return definition.value;
  });
}
function sources(): InstallStatusDependencies {
  return { access: { bind_host: "localhost", has_control_token: false, allow_insecure_non_loopback: false }, integration: "none", probe_integration: async () => ({ kind: "unconfigured", detail: "none" }), kbbl: { profileReadiness: async () => ({ kind: "acknowledged", value: [] }) }, observation_url: null, core_ready: true, definitions };
}
test("status endpoint returns typed PR blocks while optional services do not fail installation", async () => {
  const app = new Hono();
  installStatusRoute(app, () => readInstallStatus(sources()));
  const response = await app.request("/api/install-status");
  const status = await response.json();
  expect(response.status).toBe(200);
  expect(status.launch_blocks.map((block: { definition_name: string; error: { kind: string } }) => [block.definition_name, block.error.kind])).toEqual([["development", "integration_none"]]);
  expect(status.observation.availability.kind).toBe("unavailable_optional");
  expect(status.installation_failed).toBe(false);
});
test("unreachable kbbl becomes a required failure with an empty profile list and HTTP 200", async () => {
  const app = new Hono();
  installStatusRoute(app, () => readInstallStatus({ ...sources(), kbbl: { profileReadiness: async () => { throw new Error("connection refused"); } } }));
  const response = await app.request("/api/install-status");
  expect(response.status).toBe(200);
  const status = await response.json();
  expect(status).toMatchObject({ installation_failed: true, agent_profiles: [] });
  expect(status.checks).toContainEqual(expect.objectContaining({ id: "kbbl", kind: "failed", required: true }));
});
test("configured but unreachable optional services and unauthenticated agents stay non-blocking", async () => {
  const status = await readInstallStatus({ ...sources(), integration: "gated-review", probe_integration: async () => ({ kind: "unreachable", detail: "https://secret-token@private.example" }), observation_url: "http://observation.example", fetch: async () => { throw new Error("unreachable secret-token"); }, kbbl: { profileReadiness: async () => ({ kind: "acknowledged", value: [{ profile_id: "codex", label: "Codex", enabled: true, readiness: { kind: "failed", detail: "Login expired", fix: "Run codex login" } }] }) } });
  expect(status.installation_failed).toBe(false);
  expect(status.observation.availability).toMatchObject({ kind: "failed", required: false });
  expect(JSON.stringify(status)).not.toContain("secret-token");
});
test("nested non-PR workers do not acquire launch blocks", async () => {
  const original = definitions()[0]!;
  const source: ResolvedDefinition["source"] = { workflow: "nested local", input: "string", run: { units: { child: { group: { units: { local: { stage: "local" } }, outcome: {} } } }, outcome: {} }, stages: { local: { input: "string", workers: { local: { kind: "code", operation: "repository.prepare", inputs: {}, produces: [] } }, artifacts: {}, outcome: {} } } };
  expect((await readInstallStatus({ ...sources(), definitions: () => [{ ...original, source }] })).launch_blocks).toEqual([]);
});
test("served status excludes the configured control token even in failed remote probes", async () => {
  const previous = process.env.OAKRIDGE_CONTROL_TOKEN;
  const token = "route-control-secret-for-install-status";
  process.env.OAKRIDGE_CONTROL_TOKEN = token;
  try {
    const app = new Hono();
    installStatusRoute(app, () => readInstallStatus({ ...sources(),
      access: { bind_host: "0.0.0.0", has_control_token: Boolean(process.env.OAKRIDGE_CONTROL_TOKEN), allow_insecure_non_loopback: false },
      integration: "gated-review", probe_integration: async () => { throw new Error(`Unreachable https://${token}@gateway.example`); },
    }));
    const response = await app.request("/api/install-status", { headers: { authorization: `Bearer ${token}` } });
    expect(response.status).toBe(200);
    const serialized = await response.text();
    expect(serialized).toContain("authenticated_network");
    expect(serialized).not.toContain(token);
  } finally {
    if (previous === undefined) delete process.env.OAKRIDGE_CONTROL_TOKEN;
    else process.env.OAKRIDGE_CONTROL_TOKEN = previous;
  }
});
for (const state of ["none_configured", "configured"] as const) test(`observation reports ${state} grading capability without failing installation`, async () => {
  const graders = state === "none_configured" ? { state } : { state, graders: [{ runner: "test", evaluator_definition_id: "test-evaluator" }] };
  const status = await readInstallStatus({ ...sources(), observation_url: "http://observation.example",
    fetch: async () => Response.json({ service: "observation", status: "ok", database: "available", graders }) });
  expect(status.observation.availability.kind).toBe(state === "none_configured" ? "unavailable_optional" : "ok");
  expect(status.installation_failed).toBe(false);
  if (status.observation.availability.kind === "unavailable_optional") expect(status.observation.availability.fix).toContain("Grading configuration");
});
test("an invalid observation health response is a non-blocking failure", async () => {
  const status = await readInstallStatus({ ...sources(), observation_url: "http://observation.example", fetch: async () => Response.json({ status: "ok" }) });
  expect(status.observation.availability).toMatchObject({ kind: "failed", required: false });
  expect(status.installation_failed).toBe(false);
});

test("default status catalog excludes fixtures from launch blocks", async () => {
  const { definitions: _definitions, ...dependencies } = sources();
  const status = await readInstallStatus(dependencies);
  expect(status.launch_blocks.map((block) => block.definition_name).sort()).toEqual(["development", "study"]);
});
