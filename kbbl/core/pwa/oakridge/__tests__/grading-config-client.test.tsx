import { afterEach, expect, it, vi } from "vitest";
import { publishGradingDraft, saveGradingDraft, validateGradingDraft } from "../client-grading-config";

afterEach(() => vi.unstubAllGlobals());
it.each(["published", "unchanged", "reapplied"] as const)("accepts only confirmed 2xx %s outcomes", async (outcome) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ outcome, version: 7, hash: "content", published_at: "today" }, { status: outcome === "published" ? 201 : 200 })));
  expect(await publishGradingDraft({ expected_draft_digest: "digest", expected_latest_version: 6 })).toEqual({ kind: outcome, version: 7, hash: "content" });
});
const errorCases = [
  { kind: "invalid_configuration", status: 422, extra: { issues: [] }, feedback: { kind: "validation_failed", issues: [] } },
  { kind: "draft_conflict", status: 409, extra: { current_digest: "other" }, feedback: { kind: "conflict", target: "draft" } },
  { kind: "version_conflict", status: 409, extra: { current_latest_version: 9 }, feedback: { kind: "conflict", target: "version" } },
  { kind: "unconfigured_credential", status: 409, extra: { restart_required: true }, feedback: { kind: "restart_required", detail: "detail" } },
  ...(["registration_failed", "persistence_failed", "runtime_apply_failed"] as const).map((kind) => ({ kind, status: 500, extra: {}, feedback: { kind: "runtime_failed", failure: kind, detail: "detail" } })),
];
it.each(errorCases)("maps HTTP $status $kind", async ({ kind, status, extra, feedback }) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json({ error: { operation: "grading_publication", kind, code: kind, entity_id: "draft", message: "detail", detail: "detail", ...extra } }, { status })));
  expect(await publishGradingDraft({ expected_draft_digest: "d", expected_latest_version: 6 })).toEqual(feedback);
});
it("sends only the shared document and expected digest when saving", async () => {
  const fetchMock = vi.fn(async () => Response.json({ digest: "new", document: { status: "draft", definitions: [] } }));
  vi.stubGlobal("fetch", fetchMock);
  expect((await saveGradingDraft([], "old")).ok).toBe(true);
  expect(fetchMock.mock.calls[0]).toEqual(["/oakridge/observation/grading-config/draft", { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ document: { status: "draft", definitions: [] }, expected_draft_digest: "old" }) }]);
});
it("validates the stored shared draft and acknowledges valid only from the service", async () => {
  const fetchMock = vi.fn(async (_input: RequestInfo | URL) => Response.json({ valid: true }));
  vi.stubGlobal("fetch", fetchMock);
  expect(await validateGradingDraft()).toEqual({ kind: "validated" });
  expect(fetchMock.mock.calls[0]?.[0]).toBe("/oakridge/observation/grading-config/draft/validate");
});
it.each([null, {}, { outcome: "published" }])("treats an unexpected 2xx body as transport failure", async (body) => {
  vi.stubGlobal("fetch", vi.fn(async () => Response.json(body)));
  expect((await publishGradingDraft({ expected_draft_digest: "d", expected_latest_version: null })).kind).toBe("transport_error");
});
it("treats non-JSON and network failures as transport failures", async () => {
  vi.stubGlobal("fetch", vi.fn(async () => new Response("Bad gateway", { status: 502 })));
  expect((await publishGradingDraft({ expected_draft_digest: "d", expected_latest_version: null })).kind).toBe("transport_error");
  vi.mocked(fetch).mockRejectedValueOnce(new Error("Offline"));
  expect(await publishGradingDraft({ expected_draft_digest: "d", expected_latest_version: null })).toEqual({ kind: "transport_error", detail: "Offline" });
});
