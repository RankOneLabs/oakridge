import { expect, test } from "bun:test";
import { sql } from "kysely";
import { jsonText, openDatabase } from "../src/storage/database";
import type { JsonValue } from "../src/domain/primitives";

const integration = process.env.OAKRIDGE_TEST_DATABASE_URL ? test : test.skip;
integration("JSON text binding preserves scalar and collection types, including JSON null", async () => {
  const db = openDatabase(process.env.OAKRIDGE_TEST_DATABASE_URL!);
  try {
    const samples: readonly { value: JsonValue; type: string }[] = [
      { value: "lgtm", type: "string" }, { value: [], type: "array" },
      { value: ["a"], type: "array" }, { value: 0, type: "number" },
      { value: null, type: "null" }, { value: {}, type: "object" },
    ];
    for (const sample of samples) {
      const result = await sql<{ kind: string; value: JsonValue; is_sql_null: boolean }>`
        SELECT jsonb_typeof(${jsonText(sample.value)}::jsonb) AS kind,
          ${jsonText(sample.value)}::jsonb AS value,
          (${jsonText(sample.value)}::jsonb IS NULL) AS is_sql_null`.execute(db);
      expect(result.rows[0]).toEqual({ kind: sample.type, value: sample.value, is_sql_null: false });
    }
    const absent = await sql<{ kind: string | null; is_sql_null: boolean }>`
      SELECT jsonb_typeof(NULL::jsonb) AS kind, (NULL::jsonb IS NULL) AS is_sql_null`.execute(db);
    expect(absent.rows[0]).toEqual({ kind: null, is_sql_null: true });
  } finally { await db.destroy(); }
});
