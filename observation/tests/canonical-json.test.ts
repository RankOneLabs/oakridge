import { expect, test } from "bun:test";
import { Client } from "pg";
import { canonicalDigest } from "canonical-json";

function digest(result: ReturnType<typeof canonicalDigest>): string {
  if (!result.ok) throw new Error(result.error.detail);
  return result.value;
}

const databaseUrl = process.env.OAKRIDGE_TEST_DATABASE_URL;
const jsonbTest = databaseUrl || process.env.CI === "true" ? test : test.skip;
jsonbTest("a body recovered from a PostgreSQL JSONB column keeps its canonical digest", async () => {
  if (!databaseUrl) throw new Error("OAKRIDGE_TEST_DATABASE_URL is required for observation tests in CI");
  const submitted = '{"z":[{"beta":1.25e-7,"alpha":-0},3],"a":{"\\u00e9":"☃"}}';
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    await client.query("CREATE TEMP TABLE observation_canonical_v1_test (body jsonb NOT NULL)");
    await client.query("INSERT INTO observation_canonical_v1_test (body) VALUES ($1::jsonb)", [submitted]);
    const recovered = await client.query<{ body: unknown }>("SELECT body FROM observation_canonical_v1_test");
    expect(digest(canonicalDigest(recovered.rows[0]?.body))).toBe(digest(canonicalDigest(JSON.parse(submitted))));
  } finally {
    await client.end();
  }
});
