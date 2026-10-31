import { expect, test } from "bun:test";
import { createObservationClient, observationConfigFromEnv } from "./client";

const address = { artifact: { run_id: "run", unit_id: "unit", artifact_key: "draft",
  publication_ordinal: 1, namespace: "test" }, item_id_or_path: "criterion-a" };
const config = { base_url: "http://observation.invalid", namespace: "test",
  read_token: "secret-read", grade_token: "secret-grade" };

test("observation configuration is optional but partial credentials fail startup", () => {
  expect(observationConfigFromEnv({ OAKRIDGE_OBSERVATION_NAMESPACE: "default" })).toBeNull();
  expect(() => observationConfigFromEnv({ OAKRIDGE_OBSERVATION_URL: config.base_url,
    OAKRIDGE_OBSERVATION_NAMESPACE: "test" })).toThrow(/configured together/);
});

test("one summary issues a filtered lookup, eligibility read and grade read", async () => {
  const paths: string[] = [];
  const client = createObservationClient(config, (async (request: Request | URL | string) => {
    const url = new URL(String(request)); paths.push(`${url.pathname}${url.search}`);
    const body = url.pathname.endsWith("/eligibility") ? { items: [{ tag: "eligible", question_id: "q",
      question_version: "1", payload: { evidence_set_id: "e" } }] }
      : url.pathname.endsWith("/grades") ? { items: [], total: 0 }
      : url.pathname.startsWith("/v1/evidence-sets/") ? { evidence_set_id: "e", evidence_refs: [],
        is_incomplete: false, digest: "digest" }
      : { items: [{ occurrence_id: "occurrence", revision_id: "oakridge:test:unit:draft:1",
        item_id_or_path: "criterion-a", item_kind: "criterion", selected_value: "text" }], total: 1 };
    return Response.json(body);
  }));
  const summary = await client.getArtifactItemSummary(address);
  expect(summary.ok && summary.value.grade.tag).toBe("loading");
  expect(paths).toHaveLength(3);
  expect(paths[0]).toContain("item_id_or_path=criterion-a");
  await client.getEvidence("e");
  expect(paths).toHaveLength(4);
});

test("unmatched filtered lookup stays unresolved and issues no comparison read", async () => {
  const paths: string[] = [];
  const client = createObservationClient(config, (async (request: Request | URL | string) => {
    paths.push(String(request)); return Response.json({ items: [], total: 0 });
  }));
  const result = await client.getArtifactItemSummary(address);
  expect(result.ok && result.value.resolution.kind).toBe("unresolved");
  expect(paths).toHaveLength(1);
});

test("network and malformed JSON failures return contextual errors", async () => {
  const failed = createObservationClient(config, async () => { throw new Error("secret-read"); });
  const malformed = createObservationClient(config, async () => Response.json({ wrong: true }));
  for (const client of [failed, malformed]) {
    const result = await client.getArtifactItemSummary(address);
    expect(result.ok ? null : result.error).toMatchObject({ operation: "resolve_occurrence",
      entity_id: "oakridge:test:unit:draft:1", detail: expect.any(String) });
    expect(JSON.stringify(result)).not.toContain("secret-read");
  }
});
