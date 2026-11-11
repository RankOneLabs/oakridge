/**
 * Runs the real launchers in a throwaway checkout. Both scripts locate everything
 * from their own path, so copying them beside fixture services exercises their
 * actual environment, Bun and shutdown behaviour with no test switch in them.
 * The services are real Bun processes, which is what makes implicit .env loading
 * observable. Only Docker and cargo are stood in for, on PATH.
 */
import { chmodSync, closeSync, cpSync, existsSync, mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { parseGradingDefinitions, machineGraders } from "../../observation/src/grading/configuration";
import { oakridgeGradingRegistry } from "../../observation/src/producers/oakridge/profile";

const REPOSITORY = resolve(import.meta.dir, "../..");
export const LIVE_ENV_FILE = [
  "OBSERVATION_DATABASE_URL=postgres://live:live@127.0.0.1:54329/observation",
  "OBSERVATION_PORT=8791",
  `OBSERVATION_READ_CREDENTIALS=[{"producer":"oakridge","namespace":"live","token":"live-read-token"}]`,
  `OBSERVATION_GRADE_CREDENTIALS=[{"producer":"oakridge","namespace":"live","token":"live-grade-token","reviewer_id":"live"}]`,
  "TYPESAFE_API_KEY=live-provider-key",
  "FASTINO_API_KEY=unconfigured-provider-key",
  "UNRELATED_LIVE_SECRET=unrelated-secret-value",
  "",
].join("\n");

/** Exported into the launcher as a real shell profile would. */
export const INHERITED_LIVE_ENV: Readonly<Record<string, string>> = {
  OBSERVATION_DATABASE_URL: "postgres://inherited:inherited@127.0.0.1:54329/observation",
  OBSERVATION_PORT: "8791",
  OBSERVATION_HOST: "0.0.0.0",
  OBSERVATION_INGEST_CREDENTIALS: `[{"producer":"oakridge","namespace":"live","token":"inherited-ingest"}]`,
  OBSERVATION_READ_CREDENTIALS: `[{"producer":"oakridge","namespace":"live","token":"inherited-read"}]`,
  OBSERVATION_GRADE_CREDENTIALS: `[{"producer":"oakridge","namespace":"live","token":"inherited-grade","reviewer_id":"live"}]`,
  OAKRIDGE_OBSERVATION_URL: "http://127.0.0.1:8791",
  OAKRIDGE_OBSERVATION_NAMESPACE: "live",
  OAKRIDGE_OBSERVATION_INGEST_TOKEN: "inherited-ingest",
  OAKRIDGE_OBSERVATION_READ_TOKEN: "inherited-read",
  OAKRIDGE_OBSERVATION_GRADE_TOKEN: "inherited-grade",
  OAKRIDGE_POSTGRES_PORT: "54329",
  OAKRIDGE_DBOS_PORT: "8790",
  DBOS_SYSTEM_DATABASE_URL: "postgres://oakridge:oakridge@127.0.0.1:54329/oakridge",
  KBBL_PORT: "8788",
  TYPESAFE_API_KEY: "inherited-provider-key",
  OBSERVATION_LLM_JUDGE_API_KEY: "inherited-judge-key",
};

export type ObservationBehaviour = "serve" | "crash" | "hang";
export type ChildName = "observation" | "dbos" | "kbbl";
export interface ChildRecord { readonly env: Record<string, string>; readonly cwd: string; readonly argv: readonly string[]; readonly pid: number }
/** Overrides for the launcher's environment; undefined removes an inherited name. */
export type LauncherEnvironment = Readonly<Record<string, string | undefined>>;
export interface LauncherPorts { readonly kbbl: number; readonly dbos: number; readonly postgres: number; readonly observation: number }

/** Records what the process received, then serves; its paths are baked in because its environment is the thing under test. */
function serviceSource(name: ChildName, records: string, port_expression: string): string {
  return `
import { writeFileSync, existsSync, readFileSync } from "node:fs";
writeFileSync(${JSON.stringify(join(records, `${name}.json`))}, JSON.stringify({ env: process.env, cwd: process.cwd(), argv: process.argv, pid: process.pid }));
const behaviour_file = ${JSON.stringify(join(records, `${name}.behaviour`))};
const behaviour = existsSync(behaviour_file) ? readFileSync(behaviour_file, "utf8").trim() : "serve";
if (behaviour === "crash") process.exit(7);
Bun.serve({ hostname: "127.0.0.1", port: Number(${port_expression}), fetch: (request) => behaviour === "hang"
  ? new Promise(() => {}) : Response.json({ service: ${JSON.stringify(name)}, path: new URL(request.url).pathname }) });
`;
}

const DOCKER_SHIM = (state: string) => `#!/usr/bin/env bash
state=${JSON.stringify(state)}
printf '%s\\n' "$*" >> "$state/docker.log"
container() { cat "$state/container" 2>/dev/null; }
case "$1" in
  info) exit 0 ;;
  container) [ -f "$state/container" ] ;;
  run)
    shift
    while [ $# -gt 0 ]; do
      case "$1" in
        --name) printf '%s' "$2" > "$state/container" ;;
        --publish) printf '%s' "$2" > "$state/publish" ;;
        --volume) printf '%s' "\${2%%:*}" > "$state/volume" ;;
      esac
      shift
    done ;;
  inspect)
    case "$*" in
      *Running*) echo true ;;
      *Mounts*) echo "$(cat "$state/volume") " ;;
      *PortBindings*) if [ -f "$state/wrong-binding" ]; then echo "5432/tcp=127.0.0.1:54329 "; else
        echo "5432/tcp=127.0.0.1:$(sed 's/^127.0.0.1:\\([0-9]*\\):.*/\\1/' "$state/publish") "; fi ;;
    esac ;;
  exec)
    case "$*" in
      *pg_isready*) exit 0 ;;
      *--command*) if [ -f "$state/hang-postgres" ]; then exec sleep 60; fi ;;&
      *--command*"FROM pg_roles"*) [ ! -f "$state/role" ] || echo 1 ;;
      *--command*"FROM pg_database"*) [ ! -f "$state/database" ] || echo 1 ;;
      *--command*"CREATE DATABASE"*)
        if [ -f "$state/refuse-provisioning" ]; then exit 1; fi
        printf '%s\\n' "$*" >> "$state/provisioned.log"; touch "$state/database" ;;
      *) stdin="$(cat)"; printf '%s\\n' "$stdin" >> "$state/psql-stdin.log"; touch "$state/role" ;;
    esac ;;
esac
`;

export class LauncherFixture {
  readonly root = mkdtempSync(join(tmpdir(), "oakridge-launcher-"));
  readonly home = join(this.root, "home");
  readonly records = join(this.root, "records");
  readonly docker_state = join(this.root, "docker");
  readonly checkout = join(this.root, "checkout");
  readonly state_dir = join(this.root, "custom state", "shadow");
  readonly log = join(this.root, "launcher.log");
  private readonly bin = join(this.root, "bin");
  private process: ReturnType<typeof Bun.spawn> | null = null;

  constructor(readonly ports: LauncherPorts) {
    for (const directory of [this.home, this.records, this.docker_state, this.bin]) mkdirSync(directory, { recursive: true });
    const { checkout } = this;
    for (const path of ["scripts", "observation/src", "oakridge-dbos/src", "kbbl/scripts", "kbbl/core", "workflow-core"])
      mkdirSync(join(checkout, path), { recursive: true });
    for (const script of ["oakridge-shadow", "oakridge-start"]) cpSync(join(REPOSITORY, "scripts", script), join(checkout, "scripts", script));
    cpSync(join(REPOSITORY, "kbbl/scripts/kbbl-start"), join(checkout, "kbbl/scripts/kbbl-start"));
    // The provider selection is real code: the launchers run the repository's own.
    symlinkSync(join(REPOSITORY, "observation/scripts"), join(checkout, "observation/scripts"));
    writeFileSync(join(checkout, ".mcp.json"), JSON.stringify({ mcpServers: { "gated-review": { type: "http", url: "http://review.test:3555/mcp" } } }));
    writeFileSync(join(checkout, "observation/.env"), LIVE_ENV_FILE);
    writeFileSync(join(checkout, "observation/package.json"), JSON.stringify({ scripts: { start: "bun src/main.ts" } }));
    writeFileSync(join(checkout, "observation/src/main.ts"), serviceSource("observation", this.records, "process.env.OBSERVATION_PORT"));
    writeFileSync(join(checkout, "oakridge-dbos/package.json"), JSON.stringify({ scripts: { start: "bun run src/main.ts" } }));
    writeFileSync(join(checkout, "oakridge-dbos/src/main.ts"), serviceSource("dbos", this.records, "process.env.PORT"));
    writeFileSync(join(checkout, "kbbl/package.json"), JSON.stringify({ scripts: { "build:pwa": "true" } }));
    writeFileSync(join(checkout, "kbbl/core/server.ts"), serviceSource("kbbl", this.records,
      `process.argv.findLast((arg) => arg.startsWith("--port="))?.slice(7)`));
    writeFileSync(join(this.bin, "docker"), DOCKER_SHIM(this.docker_state));
    writeFileSync(join(this.bin, "cargo"), `#!/usr/bin/env bash\nmkdir -p ${JSON.stringify(join(checkout, "workflow-core/target/wasm32-unknown-unknown/debug"))}\ntouch ${JSON.stringify(join(checkout, "workflow-core/target/wasm32-unknown-unknown/debug/workflow_evaluator.wasm"))}\n`);
    for (const shim of ["docker", "cargo"]) chmodSync(join(this.bin, shim), 0o755);
  }

  /** The environment a shell with a live profile would hand the launcher. */
  environment(extra: LauncherEnvironment = {}): Record<string, string> {
    const merged = { PATH: `${this.bin}:${process.env.PATH ?? ""}`, HOME: this.home, ...INHERITED_LIVE_ENV,
      OAKRIDGE_SHADOW_NAME: "fixture", OAKRIDGE_SHADOW_STATE_DIR: this.state_dir,
      OAKRIDGE_SHADOW_KBBL_PORT: String(this.ports.kbbl), OAKRIDGE_SHADOW_DBOS_PORT: String(this.ports.dbos),
      OAKRIDGE_SHADOW_POSTGRES_PORT: String(this.ports.postgres), OAKRIDGE_SHADOW_OBSERVATION_PORT: String(this.ports.observation), ...extra };
    return Object.fromEntries(Object.entries(merged).filter((entry): entry is [string, string] => entry[1] !== undefined));
  }

  writeGraders(...runners: string[]): void {
    const parsed = parseGradingDefinitions(JSON.parse(readFileSync(join(REPOSITORY, "observation/grading-definitions.json"), "utf8")), oakridgeGradingRegistry);
    if (!parsed.ok) throw new Error(parsed.error.detail);
    const definition = parsed.value[0]!;
    const grader = machineGraders(definition)[0]!;
    writeFileSync(join(this.checkout, "observation/grading-definitions.json"), JSON.stringify([{ ...definition,
      evaluators: runners.map((runner) => ({ ...grader, runner })) }]));
  }
  behave(name: ChildName, behaviour: ObservationBehaviour): void { writeFileSync(join(this.records, `${name}.behaviour`), behaviour); }
  dockerFlag(flag: "refuse-provisioning" | "wrong-binding" | "hang-postgres"): void { writeFileSync(join(this.docker_state, flag), ""); }
  dockerLog(name: "docker" | "provisioned" | "psql-stdin"): string {
    const path = join(this.docker_state, `${name}.log`);
    return existsSync(path) ? readFileSync(path, "utf8") : "";
  }

  start(options: { readonly script?: "oakridge-shadow" | "oakridge-start"; readonly args?: readonly string[]; readonly cwd?: string;
    readonly env?: LauncherEnvironment } = {}): void {
    const script = join(this.checkout, "scripts", options.script ?? "oakridge-shadow");
    const log = openSync(this.log, "a");
    this.process = Bun.spawn([script, ...(options.args ?? ["--observation"])], { cwd: options.cwd ?? this.checkout,
      env: this.environment(options.env), stdin: "ignore", stdout: log, stderr: log });
    closeSync(log);
  }

  /** Runs a launcher command to completion, for the paths that refuse or print. */
  run(args: readonly string[], env: LauncherEnvironment = {}): { readonly code: number; readonly stdout: string; readonly stderr: string } {
    const result = Bun.spawnSync([join(this.checkout, "scripts/oakridge-shadow"), ...args], { cwd: this.checkout, env: this.environment(env) });
    return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
  }

  record(name: ChildName): ChildRecord { return JSON.parse(readFileSync(join(this.records, `${name}.json`), "utf8")) as ChildRecord; }
  hasRecord(name: ChildName): boolean { return existsSync(join(this.records, `${name}.json`)); }
  forget(name: ChildName): void { rmSync(join(this.records, `${name}.json`), { force: true }); }
  logText(): string { return existsSync(this.log) ? readFileSync(this.log, "utf8") : ""; }
  stateFile(name: string): string { return join(this.state_dir, name); }
  status(): { readonly state: string; readonly detail: string } { return JSON.parse(readFileSync(this.stateFile("observation-status.json"), "utf8")) as { state: string; detail: string }; }

  async until(condition: () => boolean | Promise<boolean>, what: string, timeout_ms = 15_000): Promise<void> {
    const deadline = Date.now() + timeout_ms;
    while (Date.now() < deadline) {
      if (await condition()) return;
      await Bun.sleep(25);
    }
    throw new Error(`timed out waiting for ${what}\n${this.logText()}`);
  }

  async answers(port: number): Promise<boolean> {
    try { return (await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(500) })).ok; }
    catch { return false; }
  }

  async stackServing(): Promise<void> {
    await this.until(async () => await this.answers(this.ports.dbos) && await this.answers(this.ports.kbbl), "DBOS and kbbl to serve");
  }

  launcherRunning(): boolean { return this.process !== null && this.process.exitCode === null; }

  /** Sends the launcher the signal an operator's stop does and waits for it to finish. */
  async stop(): Promise<number | null> {
    const launcher = this.process;
    if (!launcher) return null;
    launcher.kill("SIGTERM");
    await launcher.exited;
    this.process = null;
    return launcher.exitCode;
  }

  async dispose(): Promise<void> {
    await this.stop();
    rmSync(this.root, { recursive: true, force: true });
  }
}

export function isAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}

let next_port = 20_000 + Math.floor(Math.random() * 20_000);
export function freePorts(): LauncherPorts {
  next_port += 4;
  return { kbbl: next_port, dbos: next_port + 1, postgres: next_port + 2, observation: next_port + 3 };
}
