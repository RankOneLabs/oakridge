import { afterEach, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LauncherFixture, freePorts } from "./launcher-fixture";
let fixture: LauncherFixture;
afterEach(async () => { await fixture?.dispose(); });
test("network bind refuses before starting services", async () => {
  fixture = new LauncherFixture(freePorts());
  fixture.start({ script: "oakridge-start", args: ["--host", "0.0.0.0"] });
  await fixture.until(() => !fixture.launcherRunning(), "refusal");
  expect(fixture.logText()).toContain("oakridge: refusing to bind kbbl to 0.0.0.0 without OAKRIDGE_CONTROL_TOKEN; set OAKRIDGE_CONTROL_TOKEN to any nonempty value, bind to 127.0.0.1, or set ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1 to accept an unauthenticated network listener");
  expect(fixture.dockerLog("docker")).toBe("");
  for (const name of ["dbos", "kbbl", "observation"] as const) expect(fixture.hasRecord(name)).toBe(false);
});
test("authenticated network logs mode without revealing token", async () => {
  fixture = new LauncherFixture(freePorts());
  fixture.start({ script: "oakridge-start", args: ["--host", "0.0.0.0", `--port=${fixture.ports.kbbl}`], env: { OAKRIDGE_CONTROL_TOKEN: "s3cret-test-value", OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos) } });
  await fixture.stackServing();
  expect(fixture.logText()).toContain("oakridge: access mode: authenticated network (kbbl bound to 0.0.0.0; OAKRIDGE_CONTROL_TOKEN is set)");
  expect(fixture.logText()).not.toContain("s3cret-test-value");
  expect(fixture.record("dbos").env.OAKRIDGE_OPERATOR_BIND_HOST).toBe("0.0.0.0");
});

for (const script of ["oakridge-start", "oakridge-lan"] as const) {
  test(`${script} preserves authenticated access and internal loopback binds`, async () => {
    fixture = new LauncherFixture(freePorts());
    fixture.start({ script, args: ["--host=0.0.0.0", `--port=${fixture.ports.kbbl}`, "--observation"],
      env: { OAKRIDGE_CONTROL_TOKEN: "caller-token", OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos) } });
    await fixture.stackServing();
    await fixture.until(() => fixture.hasRecord("observation"), "observation record");
    expect(fixture.record("dbos").env.OAKRIDGE_DBOS_HOST).toBe("127.0.0.1");
    expect(fixture.record("observation").env.OBSERVATION_HOST).toBe("127.0.0.1");
    for (const name of ["kbbl", "dbos"] as const) {
      expect(fixture.record(name).env.OAKRIDGE_CONTROL_TOKEN).toBe("caller-token");
      expect(fixture.record(name).env.ALLOW_INSECURE_NON_LOOPBACK_CONTROL).toBeUndefined();
    }
    expect(fixture.record("kbbl").argv).toContain("--host=0.0.0.0");
    expect(fixture.record("dbos").argv).not.toContain("--host=0.0.0.0");
    expect(fixture.logText()).toContain("oakridge: warning: 0.0.0.0 listens on every network interface of this machine, not only Tailscale");
  });
}
for (const token of [undefined, "   "]) {
  test(`LAN wrapper refuses absent or whitespace token (${JSON.stringify(token)})`, async () => {
    fixture = new LauncherFixture(freePorts());
    fixture.start({ script: "oakridge-lan", args: [], env: { OAKRIDGE_CONTROL_TOKEN: token } });
    await fixture.until(() => !fixture.launcherRunning(), "LAN refusal");
    expect(fixture.logText()).toContain("oakridge: refusing to bind kbbl to 0.0.0.0");
  });
}
for (const insecure of [false, true]) {
  test(insecure ? "explicit insecure override is logged" : "default loopback mode is logged", async () => {
    fixture = new LauncherFixture(freePorts());
    fixture.start({ script: "oakridge-start", args: [`--port=${fixture.ports.kbbl}`, ...(insecure ? ["--host=0.0.0.0"] : [])],
      env: { OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos), ALLOW_INSECURE_NON_LOOPBACK_CONTROL: insecure ? "1" : undefined } });
    await fixture.stackServing();
    expect(fixture.logText()).toContain(insecure
      ? "oakridge: access mode: insecure network (kbbl bound to 0.0.0.0 with no control token; ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1)"
      : "oakridge: access mode: local (kbbl bound to 127.0.0.1; no control token required)");
  });
}
const lanEnvironment = (fixture: LauncherFixture, env: Record<string, string | undefined> = {}) =>
  ({ OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos), ...env });
test("LAN wrapper reads the control token from the checkout .env without logging it", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.checkout, ".env"), "# local install\nOAKRIDGE_CONTROL_TOKEN=dotenv-token\n");
  fixture.start({ script: "oakridge-lan", args: [`--port=${fixture.ports.kbbl}`], env: lanEnvironment(fixture) });
  await fixture.stackServing();
  expect(fixture.logText()).toContain("oakridge: access mode: authenticated network (kbbl bound to 0.0.0.0; OAKRIDGE_CONTROL_TOKEN is set)");
  expect(fixture.logText()).not.toContain("dotenv-token");
  for (const name of ["kbbl", "dbos"] as const) expect(fixture.record(name).env.OAKRIDGE_CONTROL_TOKEN).toBe("dotenv-token");
});
test("LAN wrapper prefers the shell control token over the checkout .env", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.checkout, ".env"), "OAKRIDGE_CONTROL_TOKEN=dotenv-token\n");
  fixture.start({ script: "oakridge-lan", args: [`--port=${fixture.ports.kbbl}`], env: lanEnvironment(fixture, { OAKRIDGE_CONTROL_TOKEN: "shell-token" }) });
  await fixture.stackServing();
  for (const name of ["kbbl", "dbos"] as const) expect(fixture.record(name).env.OAKRIDGE_CONTROL_TOKEN).toBe("shell-token");
});
test("LAN wrapper reads the insecure override from the checkout .env", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.checkout, ".env"), "#OAKRIDGE_CONTROL_TOKEN=commented-out\nALLOW_INSECURE_NON_LOOPBACK_CONTROL=1\n");
  fixture.start({ script: "oakridge-lan", args: [`--port=${fixture.ports.kbbl}`], env: lanEnvironment(fixture) });
  await fixture.stackServing();
  expect(fixture.logText()).toContain("oakridge: access mode: insecure network (kbbl bound to 0.0.0.0 with no control token; ALLOW_INSECURE_NON_LOOPBACK_CONTROL=1)");
});
test("LAN wrapper without Bun reaches the dependency check and the dated run log", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.checkout, ".env"), "OAKRIDGE_CONTROL_TOKEN=dotenv-token\n");
  const path_without_bun = (process.env.PATH ?? "").split(":").filter((directory) => !existsSync(join(directory, "bun"))).join(":");
  fixture.start({ script: "oakridge-lan", args: [], env: { PATH: path_without_bun } });
  await fixture.until(() => !fixture.launcherRunning(), "missing Bun refusal");
  expect(fixture.logText()).toContain("oakridge: bun is missing");
  // bun test runs in UTC, so take the launcher's dated log by listing rather than by today's date.
  const state = join(fixture.home, ".local/state/oakridge");
  const run_logs = readdirSync(state).filter((name) => /^run-\d{4}-\d{2}-\d{2}\.log$/.test(name));
  expect(run_logs.map((name) => readFileSync(join(state, name), "utf8")).join("")).toContain("oakridge: bun is missing");
});
