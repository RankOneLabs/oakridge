import { expect, test } from "bun:test";
import { resolve } from "node:path";
import type { DefinitionBundle } from "../src/core-client/generated-contracts";
import { advanceChildrenPage, serialChildrenRequestDeadlineMs } from "../src/runtime/advance-children";
import { runtimeFixture } from "./development-runtime-fixture";
import { withDatabase } from "./effect-fixture";

test("paged serial child advancement reaches every pending child within a bounded step budget", async () => withDatabase(async ({ db }) => {
  const original: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/children-7.json")).json();
  const bundle: DefinitionBundle = { ...original, scopes: original.scopes.map((scope) => ({ ...scope, entry_command: "begin",
    pools: scope.pools.map((pool) => ({ ...pool, limit: 10 })) })) };
  const fixture = await runtimeFixture(db, bundle, {});
  try {
    await fixture.fact("begin");
    let cursor: string | null = null;
    let pages = 0;
    do {
      const page = await advanceChildrenPage({ db, core: fixture.core, mutations: fixture.mutations, run_ids: [fixture.run_id],
        after_scope_id: cursor, max_scopes: 2, per_scope_deadline_ms: 60_000, max_request_deadline_ms: 120_000 });
      expect(page.failures).toEqual([]);
      cursor = page.next_cursor;
      pages++;
    } while (cursor !== null && pages < 20);
    expect(pages).toBeGreaterThan(1);
    expect(serialChildrenRequestDeadlineMs(100, 60_000, 120_000)).toBe(120_000);
    const children = await db.query<{ variant: string }>(`SELECT local_state->'data'->>'variant' AS variant
      FROM authority.scope_instance WHERE parent_id=$1 ORDER BY id`, [fixture.root_scope_id]);
    expect(children).toHaveLength(7);
    expect(children.every((child) => child.variant === "waiting")).toBe(true);
  } finally { fixture.core.close(); }
}), 30_000);
