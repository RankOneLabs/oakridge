/**
 * Copies saved projects from an earlier install into a running backend, since
 * a fresh database starts with none and nothing seeds them.
 *
 *   bun oakridge-dbos/scripts/import-projects.ts --to=http://127.0.0.1:8800 \
 *     [--from=postgres://…|projects.json] [--only=scout,jig] \
 *     [--repo-dir=scout=/elsewhere/scout] [--dry-run]
 *
 * The source is a pre-v2 database (`oakridge.project`, the default install's
 * URL by default) or a JSON export of those rows; `--export=<file>` writes that
 * export instead of importing. Each project goes through `POST /api/projects`,
 * so the backend validates it and assigns its id. A project whose name the
 * target already has is skipped, so a rerun is safe. `OAKRIDGE_CONTROL_TOKEN`,
 * when set, is sent as the Bearer credential.
 */
import { Client } from "pg";
import { err, ok, type Result } from "../src/domain/primitives";
import { parseProjectDraft, type ProjectDraft, type ProjectList } from "../src/http/projects";

const DEFAULT_SOURCE = "postgres://oakridge:oakridge@127.0.0.1:54329/oakridge";

/** A row of the pre-v2 `oakridge.project` table, as the source holds it. */
export interface SourceProject {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: unknown;
  readonly base_branch: string | null;
}

export type ImportOptions =
  | { readonly kind: "export"; readonly from: string; readonly file: string }
  | {
    readonly kind: "import";
    readonly from: string;
    readonly to: string;
    readonly only: readonly string[] | null;
    readonly repo_dirs: ReadonlyMap<string, string>;
    readonly is_dry_run: boolean;
  };

export type PlannedImport =
  | { readonly kind: "create"; readonly draft: ProjectDraft }
  | { readonly kind: "skip"; readonly name: string; readonly reason: string };

export function parseOptions(args: readonly string[]): Result<ImportOptions, string> {
  let from = DEFAULT_SOURCE;
  let to: string | null = null;
  let file: string | null = null;
  let only: string[] | null = null;
  const repo_dirs = new Map<string, string>();
  let is_dry_run = false;
  for (const arg of args) {
    const [flag, ...rest] = arg.split("=");
    const value = rest.join("=");
    if (flag === "--dry-run" && rest.length === 0) is_dry_run = true;
    else if (!value) return err(`${arg}: expected --flag=value`);
    else if (flag === "--from") from = value;
    else if (flag === "--to") to = value.replace(/\/+$/, "");
    else if (flag === "--export") file = value;
    else if (flag === "--only") only = value.split(",").map((name) => name.trim()).filter(Boolean);
    else if (flag === "--repo-dir") {
      const [name, ...path] = value.split("=");
      if (!name || path.length === 0) return err(`${arg}: expected --repo-dir=<project>=<path>`);
      repo_dirs.set(name, path.join("="));
    } else return err(`unknown option ${arg}`);
  }
  if (file !== null) return to === null ? ok({ kind: "export", from, file }) : err("--export and --to are exclusive");
  if (to === null) return err("--to=<backend URL> is required, e.g. --to=http://127.0.0.1:8800");
  return ok({ kind: "import", from, to, only, repo_dirs, is_dry_run });
}

/** The source rows named by `--only` (all when absent), refusing a name the source lacks. */
export function selectProjects(rows: readonly SourceProject[], only: readonly string[] | null): Result<readonly SourceProject[], string> {
  if (only === null) return ok(rows);
  const missing = only.filter((name) => !rows.some((row) => row.name === name));
  if (missing.length > 0) return err(`the source has no project named ${missing.join(", ")}`);
  return ok(rows.filter((row) => only.includes(row.name)));
}

/** A source row as a v2 draft: `base_branch` became `integration_branch`, and an empty one means none. */
export function toDraft(row: SourceProject, repo_dirs: ReadonlyMap<string, string>): Result<ProjectDraft, string> {
  const draft = parseProjectDraft({
    name: row.name,
    repo_dir: repo_dirs.get(row.name) ?? row.repo_dir,
    forge_repository: row.forge_repository,
    integration_branch: row.base_branch?.trim() ? row.base_branch.trim() : null,
  });
  return draft.ok ? ok(draft.value) : err(`${row.name}: ${draft.error.detail}`);
}

export function planImports(drafts: readonly ProjectDraft[], existing_names: ReadonlySet<string>): readonly PlannedImport[] {
  return drafts.map((draft) => existing_names.has(draft.name)
    ? { kind: "skip", name: draft.name, reason: "the target already has a project with this name" }
    : { kind: "create", draft });
}

async function readSource(from: string): Promise<Result<readonly SourceProject[], string>> {
  try {
    if (!/^postgres(ql)?:\/\//.test(from)) return ok(await Bun.file(from).json() as SourceProject[]);
    const client = new Client({ connectionString: from });
    await client.connect();
    try {
      const result = await client.query<SourceProject>(
        "SELECT name, repo_dir, forge_repository, base_branch FROM oakridge.project ORDER BY created_at, name");
      return ok(result.rows);
    } finally { await client.end(); }
  } catch (cause) { return err(`reading projects from ${redact(from)}: ${String(cause)}`); }
}

/** A source URL fit to print: its password removed. */
const redact = (from: string): string => from.replace(/(\/\/[^:/@]+):[^@]*@/, "$1:***@");

function headers(): Record<string, string> {
  const token = process.env.OAKRIDGE_CONTROL_TOKEN?.trim();
  return { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) };
}

async function request(url: string, init: RequestInit): Promise<Result<unknown, string>> {
  try {
    const response = await fetch(url, { ...init, headers: headers() });
    const body = await response.text();
    if (!response.ok) return err(`${init.method ?? "GET"} ${url}: ${response.status} ${body}`);
    return ok(body ? JSON.parse(body) : null);
  } catch (cause) { return err(`${init.method ?? "GET"} ${url}: ${String(cause)}`); }
}

async function runImport(options: Extract<ImportOptions, { kind: "import" }>): Promise<Result<string, string>> {
  const source = await readSource(options.from);
  if (!source.ok) return source;
  const selected = selectProjects(source.value, options.only);
  if (!selected.ok) return selected;
  const drafts: ProjectDraft[] = [];
  for (const row of selected.value) {
    const draft = toDraft(row, options.repo_dirs);
    if (!draft.ok) return draft;
    drafts.push(draft.value);
  }
  const unknown_overrides = [...options.repo_dirs.keys()].filter((name) => !drafts.some((draft) => draft.name === name));
  if (unknown_overrides.length > 0) return err(`--repo-dir names no selected project: ${unknown_overrides.join(", ")}`);
  const listed = await request(`${options.to}/api/projects`, { method: "GET" });
  if (!listed.ok) return listed;
  const existing = new Set((listed.value as ProjectList).items.map((project) => project.name));
  let created = 0;
  for (const planned of planImports(drafts, existing)) {
    if (planned.kind === "skip") { console.log(`skip    ${planned.name}: ${planned.reason}`); continue; }
    const { draft } = planned;
    const summary = `${draft.name} → ${draft.repo_dir}${draft.integration_branch ? ` (${draft.integration_branch})` : ""}`;
    if (options.is_dry_run) { console.log(`would create ${summary}`); continue; }
    const posted = await request(`${options.to}/api/projects`, { method: "POST", body: JSON.stringify(draft) });
    if (!posted.ok) return err(`${posted.error}\n${created} project(s) created before the failure; rerun to continue`);
    created += 1;
    console.log(`created ${summary}`);
  }
  return ok(options.is_dry_run ? "dry run: nothing written" : `${created} project(s) created`);
}

async function runExport(options: Extract<ImportOptions, { kind: "export" }>): Promise<Result<string, string>> {
  const rows = await readSource(options.from);
  if (!rows.ok) return rows;
  await Bun.write(options.file, `${JSON.stringify(rows.value, null, 2)}\n`);
  return ok(`${rows.value.length} project(s) written to ${options.file}`);
}

if (import.meta.main) {
  const options = parseOptions(process.argv.slice(2));
  const outcome = !options.ok ? options
    : options.value.kind === "export" ? await runExport(options.value) : await runImport(options.value);
  if (outcome.ok) console.log(outcome.value);
  else { console.error(`import-projects: ${outcome.error}`); process.exit(1); }
}
