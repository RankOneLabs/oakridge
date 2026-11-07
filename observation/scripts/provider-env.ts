/**
 * The launcher's view of provider settings, run with --no-env-file so this
 * process never loads the file it is filtering.
 *
 *   provider-env.ts names                                  every setting a runner reads
 *   provider-env.ts live-port --env-file <path>            the port the live service binds
 *   provider-env.ts select --env-file <path> --graders <path>
 *
 * `select` prints NAME=VALUE lines for the configured runners only. Failure
 * prints `<kind>:<entity>` on stderr, which names settings but never a value.
 */
import { parseArgs } from "node:util";
import { allProviderCredentialNames, configuredRunnerNames, credentialsForRunners, parseEnvFile,
  selectProviderEnvironment, type ProviderCredentialError } from "../src/grading/provider-credentials";
import { err, ok, type Result } from "../src/domain/primitives";

const DEFAULT_LIVE_PORT = "8791";

async function readEntries(path: string): Promise<ReadonlyMap<string, string>> {
  const file = Bun.file(path);
  return parseEnvFile(await file.exists() ? await file.text() : "");
}

/** No graders.json means no grader is configured, not that one failed. */
async function readRunners(path: string): Promise<Result<readonly string[], ProviderCredentialError>> {
  const file = Bun.file(path);
  if (!await file.exists()) return ok([]);
  try { return configuredRunnerNames(await file.json()); }
  catch { return err({ operation: "provider_credentials", kind: "invalid_graders", entity_id: "graders.json", detail: "not JSON" }); }
}

async function selectLines(env_file: string, graders: string): Promise<Result<readonly string[], ProviderCredentialError>> {
  const runners = await readRunners(graders);
  if (!runners.ok) return runners;
  const credentials = credentialsForRunners(runners.value);
  if (!credentials.ok) return credentials;
  const selected = selectProviderEnvironment(credentials.value, await readEntries(env_file));
  return selected.ok ? ok([...selected.value].map(([name, value]) => `${name}=${value}`)) : selected;
}

const { values, positionals } = parseArgs({ allowPositionals: true,
  options: { "env-file": { type: "string" }, graders: { type: "string" } } });
const [command] = positionals;
const env_file = values["env-file"];

if (command === "names") console.log(allProviderCredentialNames().join("\n"));
else if (command === "live-port" && env_file) console.log((await readEntries(env_file)).get("OBSERVATION_PORT") || DEFAULT_LIVE_PORT);
else if (command === "select" && env_file && values.graders) {
  const lines = await selectLines(env_file, values.graders);
  if (!lines.ok) { console.error(`${lines.error.kind}:${lines.error.entity_id}`); process.exit(1); }
  if (lines.value.length > 0) console.log(lines.value.join("\n"));
} else { console.error("usage: provider-env.ts names | live-port --env-file <path> | select --env-file <path> --graders <path>"); process.exit(2); }
