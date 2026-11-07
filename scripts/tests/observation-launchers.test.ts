import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { freePorts, isAlive, LauncherFixture } from "./launcher-fixture";

const TIMEOUT_MS = 40_000;
const fixtures: LauncherFixture[] = [];
function fixture(): LauncherFixture {
  const created = new LauncherFixture(freePorts());
  fixtures.push(created);
  return created;
}
afterEach(async () => { for (const created of fixtures.splice(0)) await created.dispose(); });

async function startedStack(setup: (stack: LauncherFixture) => void = () => {}): Promise<LauncherFixture> {
  const stack = fixture();
  setup(stack);
  stack.start();
  await stack.stackServing();
  return stack;
}
const observationServing = (stack: LauncherFixture) =>
  stack.until(() => stack.answers(stack.ports.observation), "observation to serve");
const token = (stack: LauncherFixture, capability: string) => readFileSync(stack.stateFile(`observation-${capability}.token`), "utf8").trim();
const credentials = (raw: string | undefined) => JSON.parse(raw ?? "[]") as { token: string; namespace: string; producer: string; reviewer_id?: string }[];

describe("shadow isolation", () => {
  test("the observation child receives only shadow-owned settings", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const { env, cwd } = stack.record("observation");
    expect(new URL(env.OBSERVATION_DATABASE_URL ?? "").host).toBe(`127.0.0.1:${stack.ports.postgres}`);
    expect(new URL(env.OBSERVATION_DATABASE_URL ?? "").pathname).toBe("/observation");
    expect(env.OBSERVATION_PORT).toBe(String(stack.ports.observation));
    expect(env.OBSERVATION_HOST).toBe("127.0.0.1");
    expect(cwd).toBe(stack.state_dir);
    expect(credentials(env.OBSERVATION_INGEST_CREDENTIALS)).toEqual([{ producer: "oakridge", namespace: "shadow-fixture", token: token(stack, "ingest") }]);
    expect(credentials(env.OBSERVATION_READ_CREDENTIALS)).toEqual([{ producer: "oakridge", namespace: "shadow-fixture", token: token(stack, "read") }]);
    expect(credentials(env.OBSERVATION_GRADE_CREDENTIALS)).toEqual([{ producer: "oakridge", namespace: "shadow-fixture", token: token(stack, "grade"), reviewer_id: "oakridge-operator" }]);
  }, TIMEOUT_MS);

  test("no inherited or dotenv value reaches any child", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const leaked = ["inherited", "live-read-token", "live-grade-token", "live-provider-key", "unrelated-secret-value", "live:live"];
    for (const child of ["observation", "dbos", "kbbl"] as const) {
      const text = JSON.stringify(stack.record(child).env);
      for (const value of leaked) expect({ child, value, leaked: text.includes(value) }).toEqual({ child, value, leaked: false });
    }
  }, TIMEOUT_MS);

  test("the observation child's environment is the named settings and nothing else", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const names = Object.keys(stack.record("observation").env).filter((name) => !["PATH", "HOME", "PWD", "OLDPWD", "SHLVL", "_"].includes(name));
    expect(names.toSorted()).toEqual(["OBSERVATION_DATABASE_URL", "OBSERVATION_GRADE_CREDENTIALS", "OBSERVATION_HOST",
      "OBSERVATION_INGEST_CREDENTIALS", "OBSERVATION_PORT", "OBSERVATION_READ_CREDENTIALS"]);
  }, TIMEOUT_MS);

  test("a launcher run from observation/ does not load its .env into kbbl", async () => {
    const stack = fixture();
    stack.start({ cwd: join(stack.checkout, "observation") });
    await stack.stackServing();
    const kbbl = JSON.stringify(stack.record("kbbl").env);
    expect(kbbl).not.toContain("unrelated-secret-value");
    expect(kbbl).not.toContain("live-provider-key");
  }, TIMEOUT_MS);

  test("capability state lives in the resolved directory, private and distinct", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const tokens = ["ingest", "read", "grade"].map((capability) => token(stack, capability));
    expect(new Set(tokens).size).toBe(3);
    for (const capability of ["ingest", "read", "grade"])
      expect(statSync(stack.stateFile(`observation-${capability}.token`)).mode & 0o777).toBe(0o600);
    expect(statSync(stack.stateFile("observation-database.password")).mode & 0o777).toBe(0o600);
    expect(existsSync(join(stack.home, ".local/state/oakridge"))).toBe(false);
    expect(existsSync(join(stack.home, ".local/state/oakridge-fixture"))).toBe(false);
  }, TIMEOUT_MS);

  test("the database is created in the shadow's container as an ordinary role", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const docker = stack.dockerLog("docker");
    expect(docker).toContain("--name oakridge-fixture-postgres");
    expect(docker).toContain(`--publish 127.0.0.1:${stack.ports.postgres}:5432`);
    expect(docker).toContain("--volume oakridge-fixture-postgres-data:/var/lib/postgresql/data");
    expect(docker).not.toMatch(/\boakridge-postgres\b/);
    expect(stack.dockerLog("provisioned")).toContain(`CREATE DATABASE "observation" OWNER "observation"`);
    expect(stack.dockerLog("psql-stdin")).toContain("NOSUPERUSER");
  }, TIMEOUT_MS);

  test("the database password never appears on a command line", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    expect(stack.dockerLog("docker")).not.toContain(readFileSync(stack.stateFile("observation-database.password"), "utf8").trim());
  }, TIMEOUT_MS);

  test("a restart keeps the database, the capabilities and the port", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const before = stack.record("observation").env;
    await stack.stop();
    stack.forget("observation");
    stack.start();
    await stack.stackServing();
    await observationServing(stack);
    const after = stack.record("observation").env;
    for (const name of ["OBSERVATION_DATABASE_URL", "OBSERVATION_PORT", "OBSERVATION_INGEST_CREDENTIALS", "OBSERVATION_READ_CREDENTIALS", "OBSERVATION_GRADE_CREDENTIALS"])
      expect(after[name]).toBe(before[name] ?? "");
    expect(stack.dockerLog("provisioned").match(/CREATE DATABASE/g)).toHaveLength(1);
  }, TIMEOUT_MS);

  test("--print-state names the resolved state with no secret, and starts nothing", () => {
    const stack = fixture();
    const printed = stack.run(["--print-state"]);
    expect(printed.code).toBe(0);
    const state = JSON.parse(printed.stdout) as { state_dir: string; observation: { port: number; namespace: string; read_token_file: string };
      postgres: { container: string; volume: string; port: number } };
    expect(state.state_dir).toBe(stack.state_dir);
    expect(state.observation).toMatchObject({ port: stack.ports.observation, namespace: "shadow-fixture", read_token_file: stack.stateFile("observation-read.token") });
    expect(state.postgres).toMatchObject({ container: "oakridge-fixture-postgres", volume: "oakridge-fixture-postgres-data", port: stack.ports.postgres });
    expect(printed.stdout).not.toContain("inherited");
    expect(stack.dockerLog("docker")).toBe("");
  });
});

describe("shadow port validation", () => {
  const refused = (env: Record<string, string>, message: string) => {
    const result = fixture().run(["--print-state"], env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain(message);
  };
  test("the live observation port is refused", () => refused({ OAKRIDGE_SHADOW_OBSERVATION_PORT: "8791" }, "belongs to the default install"));
  test("a port the shadow already uses is refused", () => {
    const stack = fixture();
    const result = stack.run(["--print-state"], { OAKRIDGE_SHADOW_OBSERVATION_PORT: String(stack.ports.dbos) });
    expect(result.stderr).toContain("ports must differ");
  });
  test("a port that is not one is refused", () => refused({ OAKRIDGE_SHADOW_OBSERVATION_PORT: "eighty" }, "is not a TCP port"));
  test("the port the live service configured for itself is refused", () => {
    const stack = fixture();
    Bun.write(join(stack.checkout, "observation/.env"), "OBSERVATION_PORT=9555\n");
    const result = stack.run(["--print-state"], { OAKRIDGE_SHADOW_OBSERVATION_PORT: "9555" });
    expect(result.stderr).toContain("belongs to the default install");
  });
  test("a port something is already serving on is refused before anything starts", async () => {
    const stack = fixture();
    const occupant = Bun.serve({ hostname: "127.0.0.1", port: stack.ports.observation, fetch: () => new Response() });
    try {
      const result = stack.run(["--observation"]);
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("is in use");
      expect(stack.dockerLog("docker")).not.toContain("run");
    } finally { await occupant.stop(true); }
  });
});

describe("provider credentials", () => {
  test("only the configured runner's key reaches observation", async () => {
    const stack = await startedStack((created) => created.writeGraders("jev_direct"));
    await observationServing(stack);
    const { env } = stack.record("observation");
    expect(env.TYPESAFE_API_KEY).toBe("live-provider-key");
    expect(env.FASTINO_API_KEY).toBeUndefined();
    expect(env.UNRELATED_LIVE_SECRET).toBeUndefined();
  }, TIMEOUT_MS);

  test("DBOS and kbbl receive no provider key, inherited or selected", async () => {
    const stack = await startedStack((created) => created.writeGraders("jev_direct"));
    await observationServing(stack);
    for (const child of ["dbos", "kbbl"] as const) {
      const { env } = stack.record(child);
      for (const name of ["TYPESAFE_API_KEY", "FASTINO_API_KEY", "OBSERVATION_LLM_JUDGE_API_KEY"]) expect(env[name]).toBeUndefined();
    }
  }, TIMEOUT_MS);

  test("the env file is read as data, not executed", async () => {
    const stack = fixture();
    const marker = join(stack.root, "executed");
    await Bun.write(join(stack.checkout, "observation/.env"), `TYPESAFE_API_KEY=$(touch ${marker})\n`);
    stack.writeGraders("jev_direct");
    stack.start();
    await stack.stackServing();
    await observationServing(stack);
    expect(existsSync(marker)).toBe(false);
    expect(stack.record("observation").env.TYPESAFE_API_KEY).toBe(`$(touch ${marker})`);
  }, TIMEOUT_MS);

  test("no secret reaches the launcher's output or status file", async () => {
    const stack = await startedStack((created) => created.writeGraders("jev_direct"));
    await observationServing(stack);
    const written = stack.logText() + readFileSync(stack.stateFile("observation-status.json"), "utf8");
    for (const secret of ["live-provider-key", token(stack, "ingest"), token(stack, "read"), token(stack, "grade"),
      readFileSync(stack.stateFile("observation-database.password"), "utf8").trim()]) expect(written).not.toContain(secret);
  }, TIMEOUT_MS);
});

describe("capability wiring", () => {
  test("DBOS holds the URL, namespace and ingest capability, and neither other", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const { env } = stack.record("dbos");
    expect(env.OAKRIDGE_OBSERVATION_URL).toBe(`http://127.0.0.1:${stack.ports.observation}`);
    expect(env.OAKRIDGE_OBSERVATION_NAMESPACE).toBe("shadow-fixture");
    expect(env.OAKRIDGE_OBSERVATION_INGEST_TOKEN).toBe(token(stack, "ingest"));
    expect(env.OAKRIDGE_OBSERVATION_READ_TOKEN).toBeUndefined();
    expect(env.OAKRIDGE_OBSERVATION_GRADE_TOKEN).toBeUndefined();
  }, TIMEOUT_MS);

  test("kbbl holds the URL and the read and grade capabilities, and not ingest", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const { env } = stack.record("kbbl");
    expect(env.OAKRIDGE_OBSERVATION_URL).toBe(`http://127.0.0.1:${stack.ports.observation}`);
    expect(env.OAKRIDGE_OBSERVATION_READ_TOKEN).toBe(token(stack, "read"));
    expect(env.OAKRIDGE_OBSERVATION_GRADE_TOKEN).toBe(token(stack, "grade"));
    expect(env.OAKRIDGE_OBSERVATION_INGEST_TOKEN).toBeUndefined();
  }, TIMEOUT_MS);

  test("DBOS and kbbl receive the one configured review endpoint", async () => {
    const stack = await startedStack();
    expect(stack.record("dbos").env.OAKRIDGE_GATED_REVIEW_URL).toBe("http://review.test:3555/mcp");
    expect(stack.record("kbbl").env.OAKRIDGE_GATED_REVIEW_URL).toBe("http://review.test:3555/mcp");
  }, TIMEOUT_MS);

  test("a shadow without --observation starts no service and gives kbbl no capability", async () => {
    const stack = fixture();
    stack.start({ args: [] });
    await stack.stackServing();
    expect(stack.hasRecord("observation")).toBe(false);
    expect(stack.record("dbos").env.OAKRIDGE_OBSERVATION_URL).toBe("");
    expect(stack.record("kbbl").env.OAKRIDGE_OBSERVATION_URL).toBe("");
    expect(stack.record("kbbl").env.OAKRIDGE_OBSERVATION_READ_TOKEN).toBe("");
  }, TIMEOUT_MS);
});

describe("supervision", () => {
  const stackSurvived = async (stack: LauncherFixture) => {
    await Bun.sleep(300);
    expect(stack.launcherRunning()).toBe(true);
    expect(await stack.answers(stack.ports.dbos)).toBe(true);
    expect(await stack.answers(stack.ports.kbbl)).toBe(true);
  };

  test("a missing configured key leaves observation unstarted and the stack serving", async () => {
    const stack = fixture();
    await Bun.write(join(stack.checkout, "observation/.env"), "UNRELATED=1\n");
    stack.writeGraders("jev_direct");
    stack.start();
    await stack.stackServing();
    await stackSurvived(stack);
    expect(stack.hasRecord("observation")).toBe(false);
    expect(stack.status()).toMatchObject({ state: "preflight_failed", detail: "missing_credential:TYPESAFE_API_KEY" });
  }, TIMEOUT_MS);

  test("an unknown configured runner leaves the stack serving and names the runner", async () => {
    const stack = await startedStack((created) => created.writeGraders("imaginary"));
    await stackSurvived(stack);
    expect(stack.status()).toMatchObject({ state: "preflight_failed", detail: "unknown_runner:imaginary" });
  }, TIMEOUT_MS);

  test("a database that cannot be provisioned leaves the stack serving", async () => {
    const stack = await startedStack((created) => created.dockerFlag("refuse-provisioning"));
    await stackSurvived(stack);
    expect(stack.hasRecord("observation")).toBe(false);
    expect(stack.status()).toMatchObject({ state: "preflight_failed", detail: "database_provisioning_failed" });
  }, TIMEOUT_MS);

  test("a container that does not match the shadow's settings gets no database", async () => {
    const stack = await startedStack((created) => created.dockerFlag("wrong-binding"));
    await stackSurvived(stack);
    expect(stack.status()).toMatchObject({ state: "preflight_failed", detail: "shadow_postgres_mismatch" });
    expect(stack.dockerLog("provisioned")).toBe("");
  }, TIMEOUT_MS);

  test("DBOS keeps the observation URL after a failed preflight, so delivery can resume", async () => {
    const stack = await startedStack((created) => created.writeGraders("imaginary"));
    expect(stack.record("dbos").env.OAKRIDGE_OBSERVATION_URL).toBe(`http://127.0.0.1:${stack.ports.observation}`);
    expect(stack.record("dbos").env.OAKRIDGE_OBSERVATION_INGEST_TOKEN).toBe(token(stack, "ingest"));
  }, TIMEOUT_MS);

  test("a service that crashes on startup leaves the stack serving", async () => {
    const stack = await startedStack((created) => created.behave("observation", "crash"));
    await stack.until(() => stack.status().state === "exited", "the exit to be recorded");
    await stackSurvived(stack);
    expect(stack.status().detail).toBe("status_7");
  }, TIMEOUT_MS);

  test("a service killed at runtime leaves the stack serving", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    process.kill(stack.record("observation").pid, "SIGKILL");
    await stack.until(() => stack.status().state === "exited", "the exit to be recorded");
    await stackSurvived(stack);
    expect(await stack.answers(stack.ports.observation)).toBe(false);
  }, TIMEOUT_MS);

  test("a hung service leaves the stack serving", async () => {
    const stack = await startedStack((created) => created.behave("observation", "hang"));
    await stack.until(() => stack.hasRecord("observation"), "observation to start");
    await stackSurvived(stack);
    expect(await stack.answers(stack.ports.observation)).toBe(false);
  }, TIMEOUT_MS);

  test("the default install's --observation also survives a failed preflight", async () => {
    const stack = fixture();
    await Bun.write(join(stack.checkout, "observation/.env"), "UNRELATED=1\n");
    stack.start({ script: "oakridge-start", args: ["--observation", `--port=${stack.ports.kbbl}`],
      env: { OBSERVATION_DATABASE_URL: undefined, OAKRIDGE_DBOS_PORT: String(stack.ports.dbos), DBOS_SYSTEM_DATABASE_URL: "postgres://unused/unused" } });
    await stack.stackServing();
    await stackSurvived(stack);
    expect(stack.hasRecord("observation")).toBe(false);
  }, TIMEOUT_MS);

  test("the default install's --observation still reads its own .env and keeps its state", async () => {
    const stack = fixture();
    await Bun.write(join(stack.checkout, "observation/.env"), `OBSERVATION_DATABASE_URL=postgres://live/observation\nOBSERVATION_PORT=${stack.ports.observation}\n`);
    stack.start({ script: "oakridge-start", args: ["--observation", `--port=${stack.ports.kbbl}`],
      env: { OBSERVATION_DATABASE_URL: undefined, OBSERVATION_PORT: undefined, OAKRIDGE_DBOS_PORT: String(stack.ports.dbos), DBOS_SYSTEM_DATABASE_URL: "postgres://unused/unused" } });
    await stack.stackServing();
    await observationServing(stack);
    expect(stack.record("observation").cwd).toBe(join(stack.checkout, "observation"));
    const read_token = readFileSync(join(stack.home, ".local/state/oakridge/observation-read.token"), "utf8").trim();
    expect(stack.record("kbbl").env.OAKRIDGE_OBSERVATION_READ_TOKEN).toBe(read_token);
    expect(credentials(stack.record("observation").env.OBSERVATION_READ_CREDENTIALS)[0]?.token).toBe(read_token);
  }, TIMEOUT_MS);

  test("the default install keeps provider keys out of DBOS and kbbl too", async () => {
    const stack = fixture();
    stack.start({ script: "oakridge-start", args: [`--port=${stack.ports.kbbl}`],
      env: { OAKRIDGE_DBOS_PORT: String(stack.ports.dbos), DBOS_SYSTEM_DATABASE_URL: "postgres://unused/unused", OAKRIDGE_OBSERVATION_URL: "" } });
    await stack.stackServing();
    expect(stack.record("dbos").env.TYPESAFE_API_KEY).toBeUndefined();
    expect(stack.record("kbbl").env.TYPESAFE_API_KEY).toBeUndefined();
    expect(stack.record("kbbl").env.OBSERVATION_LLM_JUDGE_API_KEY).toBeUndefined();
  }, TIMEOUT_MS);

  test("--isolated without the shadow's settings refuses rather than using the default state", () => {
    const stack = fixture();
    const result = Bun.spawnSync([join(stack.checkout, "scripts/oakridge-start"), "--isolated", "--observation"],
      { cwd: stack.checkout, env: { PATH: stack.environment().PATH ?? "", HOME: stack.home } });
    expect(result.exitCode).toBe(1);
    expect(result.stderr.toString()).toContain("--isolated is set by oakridge-shadow");
    expect(readdirSync(stack.home)).toEqual([]);
  }, TIMEOUT_MS);

  test("an explicit stop ends every child, observation included", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const pids = (["observation", "dbos", "kbbl"] as const).map((child) => stack.record(child).pid);
    await stack.stop();
    await stack.until(() => pids.every((pid) => !isAlive(pid)), "every child to stop");
    expect(stack.status().state).toBe("stopped");
  }, TIMEOUT_MS);

  test("DBOS exiting still ends the stack", async () => {
    const stack = await startedStack();
    await observationServing(stack);
    const observation = stack.record("observation").pid;
    process.kill(stack.record("dbos").pid, "SIGKILL");
    await stack.until(() => !stack.launcherRunning(), "the launcher to exit");
    await stack.until(() => !isAlive(observation), "observation to stop");
  }, TIMEOUT_MS);
});
