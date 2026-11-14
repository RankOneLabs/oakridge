import { afterEach, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LauncherFixture, freePorts, type LauncherEnvironment } from "./launcher-fixture";
let fixture: LauncherFixture;
let server: ReturnType<typeof Bun.serve> | undefined;
afterEach(async () => { server?.stop(true); server = undefined; await fixture?.dispose(); });
async function doctor(env: LauncherEnvironment = {}) {
  const child = Bun.spawn([join(fixture.checkout, "scripts/oakridge-doctor")], { env: fixture.environment({ OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos), OAKRIDGE_CONTROL_TOKEN: undefined, ...env }), stdout: "pipe", stderr: "pipe" });
  const [output, error, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  return { output, error, code };
}
test("stopped stack still prints static checks and absent optional gated-review, exiting zero", async () => {
  fixture = new LauncherFixture(freePorts(), { omit_mcp: true });
  const result = await doctor();
  expect(result.code).toBe(0);
  expect(result.output).toContain('"id":"openssl"');
  expect(result.output).toContain('"kind":"unavailable_optional","id":"gated_review"');
  expect(result.output).toContain("Oakridge stack is not running");
  expect(result.output).toContain("./scripts/oakridge-start");
});
test("missing required prerequisite prints an actionable failed check and exits nonzero", async () => {
  fixture = new LauncherFixture(freePorts());
  const restricted = join(fixture.root, "restricted");
  mkdirSync(restricted);
  for (const tool of ["bash", "dirname", "bun", "git", "sed", "grep"]) symlinkSync(Bun.which(tool)!, join(restricted, tool));
  symlinkSync(join(fixture.root, "bin/rustup"), join(restricted, "rustup"));
  symlinkSync(join(fixture.root, "bin/cargo"), join(restricted, "cargo"));
  const result = await doctor({ PATH: restricted });
  expect(result.code).toBe(1);
  expect(result.output).toContain('"kind":"failed","id":"openssl"');
  expect(result.output).toContain("Install openssl");
});
test("served optional failures print details and fixes without changing the verdict or leaking the token", async () => {
  fixture = new LauncherFixture(freePorts());
  const token = "doctor-test-secret";
  const optional = { kind: "failed", id: "observation", label: "Observation", required: false, detail: "Observation offline", fix: "Restart observation" };
  let authorized = false;
  server = Bun.serve({ hostname: "127.0.0.1", port: fixture.ports.dbos, fetch: (request) => {
    authorized = request.headers.get("authorization") === `Bearer ${token}`;
    return Response.json({ access_mode: { kind: "local", bind_host: "127.0.0.1" }, checks: [], agent_profiles: [], pr_integration: { selected: "none", health: { ...optional, kind: "unavailable_optional" } }, observation: { availability: optional }, launch_blocks: [], installation_failed: false });
  } });
  const result = await doctor({ OAKRIDGE_CONTROL_TOKEN: token });
  expect(result.code).toBe(0);
  expect(authorized).toBe(true);
  expect(result.output).toContain("Observation offline");
  expect(result.output).toContain("Restart observation");
  expect(result.output + result.error).not.toContain(token);
});
test("unsafe network bind is a required static failure", async () => {
  fixture = new LauncherFixture(freePorts());
  const result = await doctor({ OAKRIDGE_OPERATOR_BIND_HOST: "0.0.0.0", ALLOW_INSECURE_NON_LOOPBACK_CONTROL: undefined });
  expect(result.code).toBe(1);
  expect(result.output).toContain('"kind":"failed","id":"access"');
  expect(result.output).toContain("ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1");
});
test("malformed optional MCP configuration is a failed check without leaking its contents", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.checkout, ".mcp.json"), '{"secret":"never-show-this",');
  const result = await doctor();
  expect(result.code).toBe(0);
  expect(result.output).toContain('"kind":"failed","id":"gated_review"');
  expect(result.output + result.error).not.toContain("never-show-this");
});
test("served required failure controls the doctor's exit", async () => {
  fixture = new LauncherFixture(freePorts());
  server = Bun.serve({ hostname: "127.0.0.1", port: fixture.ports.dbos, fetch: () => Response.json({ installation_failed: true, checks: [{ kind: "failed", id: "kbbl", label: "kbbl", required: true, detail: "kbbl unavailable", fix: "Start kbbl" }] }) });
  const result = await doctor();
  expect(result.code).toBe(1);
  expect(result.output).toContain("Start kbbl");
});
test("a refused status read does not invent an installation verdict", async () => {
  fixture = new LauncherFixture(freePorts());
  server = Bun.serve({ hostname: "127.0.0.1", port: fixture.ports.dbos, fetch: () => new Response("Unauthorized", { status: 401 }) });
  const result = await doctor();
  expect(result.code).toBe(0);
  expect(result.output).toContain("HTTP 401");
  expect(result.output).toContain("check OAKRIDGE_CONTROL_TOKEN");
});
