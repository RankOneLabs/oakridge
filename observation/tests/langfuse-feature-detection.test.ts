import { expect, test } from "bun:test";
import type { LangfuseConfig } from "../src/langfuse/config";
import { detectLangfuseFeatures, requireLangfuseCapability } from "../src/langfuse/feature-detection";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";

const config: LangfuseConfig = { base_url: "https://example.langfuse.test", project_id: "project",
  credential: { public_key: "public", secret_key: "secret" }, annotation_queue_id: null,
  decision_evaluator_id: "jev-evaluator", retry: { max_attempts: 1, backoff_ms: 0 } };
const openapi = "info:\n  version: 4.36.0\npaths:\n  /api/public/v2/evaluators:\n  /api/public/annotation-queues:\n  /api/public/v3/scores:\n  /api/public/v2/evaluation-rules:\n";
const rule = (enabled: boolean, evaluatorId: string) => ({ enabled, evaluatorAssignments: [{ evaluatorId, variableMapping: null }] });

async function evaluatorStatus(pages: Record<string, unknown>) {
  const requests: string[] = [];
  const client = createLangfuseHttpClient(config, async (url) => {
    requests.push(url);
    if (url.endsWith("/api/openapi.yaml")) return new Response(openapi);
    if (url.includes("/v2/evaluators/"))
      return Response.json({ message: "Decision-model evaluators are not available through the public API" }, { status: 400 });
    if (url.includes("/v2/evaluation-rules?")) return Response.json(pages[new URL(url).searchParams.get("cursor") ?? ""]);
    return Response.json({ data: [] });
  });
  const report = await detectLangfuseFeatures(client, config);
  if (!report.ok) throw new Error(report.error.detail);
  return { status: requireLangfuseCapability(report.value, "decision_model_evaluators"), requests };
}

test("a Jev evaluator assigned to an enabled rule is available without the evaluator API", async () => {
  const { status, requests } = await evaluatorStatus({ "": { data: [rule(true, "jev-evaluator")], meta: {} } });
  expect(status.ok).toBe(true);
  expect(requests.some((url) => url.includes("/v2/evaluators/"))).toBe(false);
});

test("a Jev evaluator assigned only to a disabled rule is unavailable", async () => {
  const { status } = await evaluatorStatus({ "": { data: [rule(false, "jev-evaluator")], meta: {} } });
  expect(status).toMatchObject({ ok: false, error: { capability: "decision_model_evaluators",
    detail: "pinned decision-model evaluator is not assigned to an enabled evaluation rule" } });
});

test("the rule search follows the cursor to a later page", async () => {
  const { status } = await evaluatorStatus({ "": { data: [rule(true, "other")], meta: { cursor: "page-2" } },
    "page-2": { data: [rule(true, "jev-evaluator")], meta: {} } });
  expect(status.ok).toBe(true);
});
