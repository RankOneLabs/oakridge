import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LauncherFixture, freePorts } from "./launcher-fixture";
let fixture: LauncherFixture;
afterEach(async () => { await fixture?.dispose(); });
function start(env: Readonly<Record<string, string | undefined>> = {}): void {
  fixture.start({ script: "oakridge-start", args: [`--port=${fixture.ports.kbbl}`], env: { OAKRIDGE_DBOS_PORT: String(fixture.ports.dbos), ...env } });
}
for (const missing of ["bun", "git", "openssl"]) {
  test(`missing ${missing} refuses before cargo or Docker with install hint`, async () => {
    fixture = new LauncherFixture(freePorts());
    const path = join(fixture.root, "restricted-bin");
    mkdirSync(path);
    for (const tool of ["bash", "dirname", "bun", "git", "openssl"]) {
      if (tool !== missing) symlinkSync(Bun.which(tool)!, join(path, tool));
    }
    start({ PATH: path });
    await fixture.until(() => !fixture.launcherRunning(), "prerequisite refusal");
    expect(fixture.logText()).toContain(`oakridge: ${missing} is missing; install`);
    expect(fixture.dockerLog("docker")).toBe("");
    expect(existsSync(join(fixture.checkout, "workflow-core/target"))).toBe(false);
  });
}
test("missing wasm target names pinned toolchain install command", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.root, "bin/rustup"), "#!/bin/sh\nexit 0\n");
  start();
  await fixture.until(() => !fixture.launcherRunning(), "wasm refusal");
  expect(fixture.logText()).toContain("rustup target add wasm32-unknown-unknown --toolchain 1.93.1");
});
test("custom WASM bypasses target prerequisite", async () => {
  fixture = new LauncherFixture(freePorts());
  writeFileSync(join(fixture.root, "bin/rustup"), "#!/bin/sh\nexit 0\n");
  const wasm = join(fixture.root, "custom.wasm");
  writeFileSync(wasm, "fixture");
  start({ OAKRIDGE_CORE_WASM: wasm });
  await fixture.stackServing();
});
test("default WASM builds with the same pinned toolchain checked by rustup", async () => {
  fixture = new LauncherFixture(freePorts());
  const toolchain = readFileSync(join(fixture.checkout, "workflow-core/rust-toolchain.toml"), "utf8")
    .match(/^channel = "([^"]+)"$/m)![1]!;
  const cargo = join(fixture.root, "bin/cargo");
  const cargoShim = readFileSync(cargo, "utf8");
  writeFileSync(cargo, cargoShim.replace("#!/usr/bin/env bash\n",
    `#!/usr/bin/env bash\n[ "$1" = "+${toolchain}" ] && [ "$2" = build ] || exit 1\n`));
  writeFileSync(join(fixture.root, "bin/rustup"),
    `#!/bin/sh\n[ "$*" = "target list --installed --toolchain ${toolchain}" ] || exit 1\necho wasm32-unknown-unknown\n`);
  start();
  await fixture.stackServing();
  expect(existsSync(join(fixture.checkout, "workflow-core/target/wasm32-unknown-unknown/debug/workflow_evaluator.wasm"))).toBe(true);
});
for (const both of [false, true]) {
  test(both ? "no adapters refuses before services" : "one missing adapter warns and starts", async () => {
    fixture = new LauncherFixture(freePorts());
    rmSync(join(fixture.checkout, "kbbl/node_modules/.bin/codex-acp"));
    if (both) rmSync(join(fixture.checkout, "kbbl/node_modules/.bin/claude-agent-acp"));
    start();
    if (both) {
      await fixture.until(() => !fixture.launcherRunning(), "adapter refusal");
      expect(fixture.hasRecord("dbos")).toBe(false);
    } else await fixture.stackServing();
    expect(fixture.logText()).toContain("oakridge: warning: codex-acp is missing; run bun install --frozen-lockfile");
  });
}
test("absent local MCP config starts with empty child URLs", async () => {
  fixture = new LauncherFixture(freePorts(), { omit_mcp: true });
  start({ OAKRIDGE_GITHUB_TOKEN: "inherited-fixture" });
  await fixture.stackServing();
  expect(fixture.logText()).toContain("oakridge: gated-review is not configured (no .mcp.json); copy .mcp.example.json to .mcp.json to enable it");
  for (const name of ["dbos", "kbbl"] as const) expect(fixture.record(name).env.OAKRIDGE_GATED_REVIEW_URL).toBe("");
  expect(fixture.record("dbos").env.OAKRIDGE_GITHUB_TOKEN).toBe("inherited-fixture");
  expect(readFileSync(join(fixture.checkout, "scripts/oakridge-start"), "utf8")).not.toContain("OAKRIDGE_GITHUB_TOKEN");
});
