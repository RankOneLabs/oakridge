import { beforeAll, afterAll, expect, test } from "bun:test";
import type { ProjectId } from "../src/domain/primitives";
import { createProject, updateProject, listProjects, hasProject } from "../src/storage/operator-store";
import { openAuthority, type Authority } from "./authority-fixture";

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

