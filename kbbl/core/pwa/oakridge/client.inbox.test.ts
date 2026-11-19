import { afterEach, describe, expect, it, vi } from "vitest";
import sample from "./__fixtures__/v2-adapter-sample.json";
import definitionFixture from "./__fixtures__/v2-definition-detail.json";
import { fetchReviewInbox, invalidateCachedRunUnits, refreshReviewInboxRun } from "./client";

const runId = sample.run.run_id;
const definition = definitionFixture.definition;

const calls = (respond: (path: string) => unknown) => vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
  const body = respond(String(input));
  if (body instanceof Response) return body;
  return Response.json(body);
});

afterEach(() => { vi.restoreAllMocks(); invalidateCachedRunUnits(null); });

describe("v2 Oakridge client inbox", () => {
  it("uses a batched inbox and one cached units read per run, then refreshes only that run", async () => {
    const fetch = calls((path) => path.includes("/run-inboxes") ? { items: [sample.inbox] }
      : path.includes("/api/runs?") ? { items: [sample.run], next_cursor: null }
      : path.includes("/api/definitions/") ? definition
      : path.includes("/inbox") ? { items: [] }
      : path.includes("/units?") ? sample.units : sample.run);
    const inbox = await fetchReviewInbox();
    await refreshReviewInboxRun(runId, inbox);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes("/units?"))).toHaveLength(1);
    invalidateCachedRunUnits(runId);
    await refreshReviewInboxRun(runId, inbox);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes("/units?"))).toHaveLength(2);
    expect(fetch.mock.calls.filter(([path]) => String(path).includes("/run-inboxes"))).toHaveLength(1);
  });

  it("uses and caches the pinned workflow name across inbox reads and refreshes", async () => {
    const studyRun = { ...sample.run, definition_id: "study-def" };
    const fetch = calls((path) => {
      if (path.includes("/api/runs?")) return { items: [studyRun], next_cursor: null };
      if (path.endsWith("/api/definitions/study-def")) return { ...definition, bundle: { ...definition.bundle, key: "study" } };
      if (path.includes("/run-inboxes")) return { items: [sample.inbox] };
      if (path.includes("/units?")) return sample.units;
      if (path.endsWith("/inbox")) return sample.inbox;
      if (path.endsWith(`/runs/${runId}`)) return { ...studyRun, title: "Updated study title" };
      throw new Error(`unexpected inbox request: ${path}`);
    });

    const inbox = await fetchReviewInbox();
    expect(inbox.items.length).toBeGreaterThan(0);
    expect(inbox.items.every((item) => item.workflow_name === "study")).toBe(true);
    expect(inbox.cohorts.map((cohort) => cohort.workflow_name)).toEqual(["study", "study"]);

    const refreshed = await refreshReviewInboxRun(runId, inbox);
    expect(refreshed.items.length).toBeGreaterThan(0);
    expect(refreshed.items.every((item) => item.workflow_name === "study" && item.run_title === "Updated study title")).toBe(true);

    await fetchReviewInbox();
    expect(fetch.mock.calls.filter(([path]) => String(path).endsWith("/api/definitions/study-def"))).toHaveLength(1);
  });

  it("retries a pin lookup after a failed definition read", async () => {
    const run = { ...sample.run, definition_id: "retry-definition" };
    let definitionReads = 0;
    calls((path) => {
      if (path.includes("/api/runs?")) return { items: [run], next_cursor: null };
      if (path.includes("/run-inboxes")) return { items: [sample.inbox] };
      if (path.includes("/units?")) return sample.units;
      if (path.endsWith("/api/definitions/retry-definition")) {
        definitionReads += 1;
        return definitionReads === 1 ? new Response(null, { status: 503 }) : definition;
      }
      throw new Error(`unexpected inbox request: ${path}`);
    });

    await expect(fetchReviewInbox()).rejects.toThrow("503");
    const inbox = await fetchReviewInbox();
    expect(inbox.items[0]?.workflow_name).toBe("development");
    expect(definitionReads).toBe(2);
  });
});
