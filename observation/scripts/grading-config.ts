/** Offline recovery and one-time migration. Run while observation is stopped. */
import { configurationDocumentSchema, planRegistration } from "../src/grading/configuration";
import { createGradingConfigStore, type GradingConfigStore } from "../src/grading/configuration-store";
import { createGradingPublication, type GradingPublication, type PublicationOutcome } from "../src/grading/publication";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { credentialsFromEnv } from "../src/http/ingest-auth";
import { oakridgeGradingRegistry, oakridgeProfile } from "../src/producers/oakridge/profile";
import { openDatabase } from "../src/storage/database";
import { migrateEmptyDatabase } from "../src/storage/migrate";
import { err, type Result } from "../src/domain/primitives";

export type ConfigurationCommand = { readonly command: "import"; readonly file: string } | { readonly command: "republish"; readonly version: number };
export interface CommandFailure { readonly operation: "grading_config_cli"; readonly entity_id: string; readonly detail: string }
const failure = (entity_id: string, detail: string): Result<never, CommandFailure> => err({ operation: "grading_config_cli", entity_id, detail });
export async function runConfigurationCommand(command: ConfigurationCommand, store: GradingConfigStore, publication: GradingPublication): Promise<Result<PublicationOutcome, CommandFailure>> {
  const latest = await store.listVersions();
  if (!latest.ok) return failure(latest.error.entity_id, latest.error.detail);
  if (command.command === "import" && latest.value.length > 0) return failure("import", "a published version already exists");
  const current = await store.readDraft();
  if (!current.ok) return failure(current.error.entity_id, current.error.detail);
  let digest: string;
  if (command.command === "republish") {
    const restored = await publication.restoreDraft(command.version, current.value?.digest ?? null);
    if (!restored.ok) return failure(restored.error.entity_id, restored.error.detail);
    digest = restored.value.digest;
  } else {
    let raw: unknown;
    try { raw = await Bun.file(command.file).json(); }
    catch (cause) { return failure(command.file, cause instanceof Error ? cause.message : String(cause)); }
    if (!Array.isArray(raw)) return failure(command.file, "expected a top-level definitions array");
    const parsed = configurationDocumentSchema.safeParse({ status: "draft", definitions: raw });
    if (!parsed.success || parsed.data.status !== "draft") return failure(command.file, "expected JSON definitions");
    const saved = await store.saveDraft(current.value?.digest ?? null, parsed.data);
    if (!saved.ok) return failure(saved.error.entity_id, saved.error.detail);
    digest = saved.value.digest;
  }
  const published = await publication.publish({ expected_draft_digest: digest, expected_latest_version: latest.value.at(-1) ?? null, force_new_version: command.command === "republish" });
  return published.ok ? published : failure(published.error.entity_id, `${published.error.kind}: ${published.error.detail}`);
}

export async function configurationCli(command: ConfigurationCommand, env: NodeJS.ProcessEnv = process.env): Promise<Result<PublicationOutcome, CommandFailure>> {
  if (!env.OBSERVATION_DATABASE_URL) return failure("environment", "OBSERVATION_DATABASE_URL is required");
  if (!env.OBSERVATION_GRADING_CONFIG_DIR) return failure("environment", "OBSERVATION_GRADING_CONFIG_DIR is required");
  const empty = planRegistration([], oakridgeGradingRegistry);
  if (!empty.ok) return failure(empty.error.entity_id, empty.error.detail);
  const runtime = new RuntimeConfiguration(runtimeSnapshot({ version: null, hash: null, registration: empty.value,
    profile: oakridgeProfile([], empty.value.collector), applied_at: new Date().toISOString() }));
  const db = openDatabase(env.OBSERVATION_DATABASE_URL);
  try {
    await migrateEmptyDatabase(db);
    const store = createGradingConfigStore(env.OBSERVATION_GRADING_CONFIG_DIR);
    const publication = createGradingPublication({ db, store, runtime, registry: oakridgeGradingRegistry,
      credentials: credentialsFromEnv(env), env, profile: (registration) => oakridgeProfile(registration.questions, registration.collector) });
    return await runConfigurationCommand(command, store, publication);
  } finally { await db.destroy(); }
}
if (import.meta.main) {
  const [command, argument, ...extra] = process.argv.slice(2);
  if (extra.length || !argument || (command !== "import" && command !== "republish")
    || (command === "republish" && (!/^\d+$/.test(argument) || Number(argument) < 1 || Number(argument) > 999999))) {
    console.error("usage: grading-config.ts import <file> | republish <version>"); process.exit(2);
  }
  const result = await configurationCli(command === "import" ? { command, file: argument } : { command, version: Number(argument) });
  if (!result.ok) { console.error(`${result.error.entity_id}: ${result.error.detail}`); process.exit(1); }
  console.log(JSON.stringify(result.value));
}
