import { expect, test } from "bun:test";

import { requireV2CutoverDatabase } from "../src/storage/cutover";
import type { SqlExecutor } from "../src/storage/sql-executor";

const inventory = (legacy_attempt_count: string, legacy_stage_count: string): SqlExecutor => ({
  async query<Row extends object>() {
    return [{ legacy_attempt_count, legacy_stage_count }] as unknown as readonly Row[];
  },
});

test("a fresh v2 application database is accepted", async () => {
  expect(await requireV2CutoverDatabase(inventory("0", "0"))).toEqual({
    ok: true,
    value: { legacy_attempt_count: 0, legacy_stage_count: 0 },
  });
});

test("startup refuses legacy workflow attempts instead of reinterpreting them", async () => {
  const result = await requireV2CutoverDatabase(inventory("2", "3"));
  expect(result).toEqual({
    ok: false,
    error: expect.objectContaining({
      operation: "require_v2_cutover_database",
      kind: "legacy_topology_present",
      inventory: { legacy_attempt_count: 2, legacy_stage_count: 3 },
    }),
  });
});
