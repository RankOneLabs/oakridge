import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { compileWorkflow } from "../src/core-client/client";
import type { ProjectId, RunId } from "../src/domain/primitives";
import { readWorkflowPrompts } from "../src/runtime/prompt-files";
import { createProject, findLaunchableDefinition, hasProject, listProjects, pinDefinition, readPromptTexts,
  setDefinitionArchived, setRunArchived, updateProject } from "../src/storage/registry-store";
import { launch, openAuthority, pinSample, sampleWorkflow, type Authority } from "./authority-fixture";

let authority: Authority;
beforeAll(async () => { authority = await openAuthority(); });
afterAll(async () => { await authority.close(); });

const draft = (name: string) => ({ name, repo_dir: `/repos/${name}`, forge_repository: null, integration_branch: "main" });
const announcements = (key: string) => authority.db.selectFrom("authority.operator_event").select("payload").where("run_key", "=", key).execute();

test("projects are created, listed and edited, with names kept unique", async () => {
  const created = await createProject(authority.db, draft("alpha"));
  if (!created.ok) throw new Error("project not created");
  const id = created.value.id;
  const duplicate = await createProject(authority.db, draft("alpha"));
  const renamed = await updateProject(authority.db, id, { ...draft("beta"), forge_repository: { provider: "github", owner: "o", name: "n" } });
  const missing = await updateProject(authority.db, crypto.randomUUID() as ProjectId, draft("gamma"));
  const listed = await listProjects(authority.db);
  expect({ created: created.ok, duplicate: duplicate.ok ? null : duplicate.error.kind, renamed: renamed.ok ? renamed.value.forge_repository : null,
    missing: missing.ok ? null : missing.error.kind, listed: listed.map((project) => project.name), has: await hasProject(authority.db, id),
    announced: (await announcements(id)).length })
    .toEqual({ created: true, duplicate: "duplicate_name", renamed: { provider: "github", owner: "o", name: "n" },
      missing: "missing", listed: ["beta"], has: true, announced: 2 });
});

test("pinning stores each prompt by digest and the bundle's path map; a repeat returns the bundle pinned first", async () => {
  const first = await pinSample(authority);
  const again = await pinSample(authority);
  const bundle = await authority.db.selectFrom("authority.definition_bundle").select("prompts").where("id", "=", first.bundle_id).executeTakeFirstOrThrow();
  const texts = await readPromptTexts(authority.db, Object.values(bundle.prompts));
  expect({ same: again.bundle_id === first.bundle_id, paths: Object.keys(bundle.prompts).sort(), stored: texts.size })
    .toEqual({ same: true, paths: ["review-loop/critique.md", "review-loop/editor.md", "review-loop/revise.md", "review-loop/write.md"], stored: 4 });
});

test("a pinned definition keeps its prompt text after the file changes", async () => {
  const root = mkdtempSync(resolve(tmpdir(), "oakridge-prompt-root-"));
  const previous = process.env.OAKRIDGE_PROMPT_ROOT;
  try {
    mkdirSync(resolve(root, "workflow-config/prompts/review-loop"), { recursive: true });
    const workflow = sampleWorkflow("review-loop");
    const write = (text: string) => { for (const name of ["write", "revise", "critique", "editor"])
      writeFileSync(resolve(root, `workflow-config/prompts/review-loop/${name}.md`), `${text} {{topic}}\n`); };
    process.env.OAKRIDGE_PROMPT_ROOT = root;
    write("First");
    const read = readWorkflowPrompts(workflow);
    if (!read.ok) throw new Error(read.error.detail);
    write("Edited");
    const digest = read.value["review-loop/write.md"]!.content_digest;
    await authority.db.insertInto("authority.prompt_content").values(Object.values(read.value)).onConflict((c) => c.doNothing()).execute();
    expect((await readPromptTexts(authority.db, [digest])).get(digest)).toBe("First {{topic}}\n");
  } finally {
    if (previous === undefined) delete process.env.OAKRIDGE_PROMPT_ROOT; else process.env.OAKRIDGE_PROMPT_ROOT = previous;
    rmSync(root, { recursive: true, force: true });
  }
});

test("a prompt path outside workflow-config/prompts is refused", () => {
  const workflow = sampleWorkflow("review-loop");
  const stages = { ...workflow.stages, document: { ...workflow.stages.document!, reviews: { editor: { ...workflow.stages.document!.reviews!.editor!, prompt: "../../package.json" } } } };
  const read = readWorkflowPrompts({ ...workflow, stages });
  expect(read.ok ? null : read.error.entity_id).toBe("../../package.json");
});

test("an archived definition cannot be launched; runs and definitions announce their archiving", async () => {
  const pinned = await pinSample(authority);
  const { run_id } = await launch(authority, { bundle_id: pinned.bundle_id, request_id: crypto.randomUUID(), input: { topic: "x" } });
  const run_archived = await setRunArchived(authority.db, run_id, true);
  const missing_run = await setRunArchived(authority.db, "run-missing" as RunId, true);
  const launchable = await findLaunchableDefinition(authority.db, pinned.digest);
  await setDefinitionArchived(authority.db, pinned.bundle_id, true);
  const archived = await findLaunchableDefinition(authority.db, pinned.digest);
  await setDefinitionArchived(authority.db, pinned.bundle_id, false);
  expect({ run_archived, missing_run, launchable, archived, run_events: (await announcements(run_id)).map((row) => row.payload.kind) })
    .toEqual({ run_archived: true, missing_run: false, launchable: pinned.bundle_id, archived: null, run_events: ["run_event", "invalidate"] });
});

test("pinning a workflow with unknown prompt paths still reports the missing file by path", () => {
  const workflow = sampleWorkflow("review-loop");
  const stages = { ...workflow.stages, document: { ...workflow.stages.document!, reviews: { editor: { ...workflow.stages.document!.reviews!.editor!, prompt: "review-loop/absent.md" } } } };
  const read = readWorkflowPrompts({ ...workflow, stages });
  expect(read.ok ? null : read.error.entity_id).toBe("review-loop/absent.md");
});

test("pinDefinition records a newly pinned bundle on the operator stream", async () => {
  const workflow = { ...sampleWorkflow("review-loop"), workflow: "review_loop_variant" };
  const prompts = readWorkflowPrompts(workflow);
  if (!prompts.ok) throw new Error(prompts.error.detail);
  const compiled = await compileWorkflow(authority.core, { workflow,
    prompts: Object.fromEntries(Object.entries(prompts.value).map(([path, prompt]) => [path, prompt.content])) });
  if (!compiled.ok) throw new Error(compiled.error.detail);
  const pinned = await pinDefinition(authority.db, { source: workflow, compiled: compiled.value, prompts: prompts.value });
  expect((await announcements(pinned.bundle.id)).map((row) => row.payload.kind)).toEqual(["invalidate"]);
});
