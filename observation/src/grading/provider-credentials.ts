import { z } from "zod";
import { err, ok, type Result } from "../domain/primitives";
import { runnerEntry, runnerRegistry, type RunnerCredentials } from "./runner";

/**
 * Which provider settings the observation child may receive. The launcher runs
 * this over the real observation/.env so nothing else in that file, its database
 * URL, port or capabilities above all, reaches a shadow service.
 */
export interface ProviderCredentialError {
  readonly operation: "provider_credentials";
  readonly kind: "invalid_graders" | "unknown_runner" | "missing_credential";
  readonly entity_id: string;
  readonly detail: string;
}
/** The selected settings, by name; only ever handed to the observation child. */
export type ProviderEnvironment = ReadonlyMap<string, string>;

const failure = (kind: ProviderCredentialError["kind"], entity_id: string, detail: string): Result<never, ProviderCredentialError> =>
  err({ operation: "provider_credentials", kind, entity_id, detail });

/** Every setting a retained runner reads, so the launcher can keep all of them away from DBOS and kbbl. */
export function allProviderCredentialNames(): readonly string[] {
  return Object.values<{ readonly credentials: RunnerCredentials }>(runnerRegistry)
    .flatMap(({ credentials }) => [...credentials.required, ...credentials.optional]);
}

/** The slice of graders.json this boundary needs: which runners are selected. */
const graderSelection = z.looseObject({ questions: z.array(z.looseObject({
  graders: z.array(z.looseObject({ runner: z.string().min(1) })).min(1) })) });

export function configuredRunnerNames(graders: unknown): Result<readonly string[], ProviderCredentialError> {
  const parsed = graderSelection.safeParse(graders);
  if (!parsed.success) return failure("invalid_graders", "graders.json", "expected questions[].graders[].runner");
  return ok([...new Set(parsed.data.questions.flatMap((question) => question.graders.map((grader) => grader.runner)))]);
}

/** Runner requirements combined; an unknown runner fails instead of selecting nothing for it. */
export function credentialsForRunners(runners: readonly string[]): Result<RunnerCredentials, ProviderCredentialError> {
  const required: string[] = [];
  const optional: string[] = [];
  for (const runner of runners) {
    const entry = runnerEntry(runner);
    if (!entry) return failure("unknown_runner", runner, "no retained runner has this name");
    required.push(...entry.credentials.required);
    optional.push(...entry.credentials.optional);
  }
  return ok({ required: [...new Set(required)], optional: [...new Set(optional)] });
}

const ASSIGNMENT = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/;

function assignedValue(raw: string): string {
  const value = raw.trim();
  const quoted = /^(["'])(.*)\1(?:\s+#.*)?$/.exec(value);
  if (quoted) return quoted[2] ?? "";
  return value.replace(/\s+#.*$/, "");
}

/** Reads assignments as data: nothing is expanded or executed, so `$(cmd)` stays those characters. */
export function parseEnvFile(text: string): ReadonlyMap<string, string> {
  const entries = new Map<string, string>();
  for (const line of text.split(/\r?\n/)) {
    const assignment = ASSIGNMENT.exec(line);
    if (assignment?.[1] && !line.trimStart().startsWith("#")) entries.set(assignment[1], assignedValue(assignment[2] ?? ""));
  }
  return entries;
}

export function selectProviderEnvironment(credentials: RunnerCredentials, entries: ReadonlyMap<string, string>):
Result<ProviderEnvironment, ProviderCredentialError> {
  const missing = credentials.required.filter((name) => !entries.get(name));
  if (missing.length > 0) return failure("missing_credential", missing.join(","), "a configured runner's required setting is absent");
  const selected = [...credentials.required, ...credentials.optional]
    .flatMap((name): [string, string][] => { const value = entries.get(name); return value ? [[name, value]] : []; });
  return ok(new Map(selected));
}
