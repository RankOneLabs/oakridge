import { afterEach, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configurationCli, runConfigurationCommand } from "../scripts/grading-config";
import { createGradingConfigStore } from "../src/grading/configuration-store";
import { createGradingPublication } from "../src/grading/publication";
import { planRegistration } from "../src/grading/configuration";
import { RuntimeConfiguration, runtimeSnapshot } from "../src/grading/runtime-configuration";
import { oakridgeProfile, oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import type { Database } from "../src/storage/database";
import { fixtureDefinitions, credentialEnv, databaseUrl, integration, scratchDatabase, tenant } from "./grading-fixture";

const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))); });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "config-cli-")); roots.push(root);
  const file = join(root, "legacy.json");
  const definitions = (await fixtureDefinitions()).map((entry) => ({ ...entry, evaluators: [] }));
  await Bun.write(file, JSON.stringify(definitions));
  const store = createGradingConfigStore(join(root, "store"));
  const empty = planRegistration([], oakridgeGradingRegistry);
  if (!empty.ok) throw new Error(empty.error.detail);
  const runtime = new RuntimeConfiguration(runtimeSnapshot({ version: null, hash: null, registration: empty.value,
    profile: oakridgeProfile([], empty.value.collector), applied_at: "2026-11-01T00:00:00Z" }));
  const publication = createGradingPublication({ store, runtime, db: {} as Database, credentials: { ingest: [], read: [] },
    registry: oakridgeGradingRegistry, env: {}, profile: (registration) => oakridgeProfile(registration.questions, registration.collector) });
  return { root, file, definitions, store, publication };
}
test("offline import preserves semantic content as version one and refuses every subsequent import", async () => {
  const h = await fixture();
  expect(await runConfigurationCommand({ command: "import", file: h.file }, h.store, h.publication)).toMatchObject({ ok: true, value: { version: 1, outcome: "published" } });
  expect(await h.store.readVersion(1)).toMatchObject({ ok: true, value: { definitions: h.definitions } });
  expect(await runConfigurationCommand({ command: "import", file: h.file }, h.store, h.publication)).toMatchObject({ ok: false, error: { detail: "a published version already exists" } });
});
test("republish restores an older version through the publication service as a new immutable version", async () => {
  const h = await fixture();
  await runConfigurationCommand({ command: "import", file: h.file }, h.store, h.publication);
  const latest = await h.store.readDraft();
  if (!latest.ok || !latest.value) throw new Error("missing draft");
  const saved = await h.store.saveDraft(latest.value.digest, { status: "draft", definitions: [{ ...h.definitions[0]!, id: "changed" }] });
  if (!saved.ok) throw new Error(saved.error.detail);
  await h.publication.publish({ expected_draft_digest: saved.value.digest, expected_latest_version: 1 });
  expect(await runConfigurationCommand({ command: "republish", version: 1 }, h.store, h.publication)).toMatchObject({ ok: true, value: { version: 3 } });
  expect(await h.store.latestVersion()).toMatchObject({ ok: true, value: { definitions: h.definitions } });
});
test("import requires a top-level definitions array", async () => {
  const h = await fixture(); await Bun.write(h.file, '{"definitions":[]}');
  expect(await runConfigurationCommand({ command: "import", file: h.file }, h.store, h.publication)).toMatchObject({ ok: false, error: { detail: "expected a top-level definitions array" } });
});
test("offline CLI requires the same store and database environment as startup", async () => {
  expect(await configurationCli({ command: "republish", version: 1 }, {})).toMatchObject({ ok: false, error: { detail: "OBSERVATION_DATABASE_URL is required" } });
  expect(await configurationCli({ command: "republish", version: 1 }, { OBSERVATION_DATABASE_URL: "postgres://unused" })).toMatchObject({ ok: false, error: { detail: "OBSERVATION_GRADING_CONFIG_DIR is required" } });
});
integration("offline CLI opens the startup database and registers imported definitions without a running service", async () => scratchDatabase(async (db) => {
  const h = await fixture();
  const env = { ...credentialEnv(h.definitions), OBSERVATION_DATABASE_URL: await databaseUrl(db), OBSERVATION_GRADING_CONFIG_DIR: join(h.root, "store"),
    OBSERVATION_READ_CREDENTIALS: JSON.stringify([{ ...tenant, token: "read" }]) };
  expect(await configurationCli({ command: "import", file: h.file }, env)).toMatchObject({ ok: true, value: { version: 1 } });
  const changed = await h.store.allocateAndWritePublished({ definitions: [{ ...h.definitions[0]!, id: "changed" }], published_at: new Date().toISOString() });
  expect(changed.ok).toBe(true);
  expect(await configurationCli({ command: "republish", version: 1 }, env)).toMatchObject({ ok: true, value: { version: 3 } });
}));

test("offline recovery can supersede malformed latest content and always appends a version", async () => {
  const h = await fixture();
  await runConfigurationCommand({ command: "import", file: h.file }, h.store, h.publication);
  await Bun.write(join(h.root, "store/versions/000002.json"), "{broken JSON");
  expect(await runConfigurationCommand({ command: "republish", version: 1 }, h.store, h.publication)).toMatchObject({ ok: true, value: { version: 3, outcome: "published" } });
  expect(await runConfigurationCommand({ command: "republish", version: 3 }, h.store, h.publication)).toMatchObject({ ok: true, value: { version: 4, outcome: "published" } });
});
