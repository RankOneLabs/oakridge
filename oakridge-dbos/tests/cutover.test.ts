import { expect, test } from "bun:test";

import { requireV2CutoverDatabase } from "../src/storage/cutover";
import type { SqlExecutor } from "../src/storage/sql-executor";

const inventory = (legacy_stage_count: string): SqlExecutor => ({
  async query<Row extends object>() {
    return [{ legacy_stage_count }] as unknown as readonly Row[];
  },
});

test("a fresh v2 application database is accepted", async () => {
  expect(await requireV2CutoverDatabase(inventory("0"))).toEqual({
    ok: true,
    value: { legacy_stage_count: 0 },
  });
});

test("startup refuses attempt-owned legacy stages instead of reinterpreting them", async () => {
  const result = await requireV2CutoverDatabase(inventory("3"));
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      operation: "require_v2_cutover_database",
      kind: "legacy_topology_present",
      inventory: { legacy_stage_count: 3 },
    }),
  });
});
