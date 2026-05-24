import { describe, expect, test } from "bun:test";
import {
  parsePrUrl,
  parsePrViewJson,
  narrowGhStderr,
  type PrState,
  type ReviewThread,
} from "./gh-gateway";

// ── parsePrUrl ────────────────────────────────────────────────────────────────

describe("parsePrUrl", () => {
  test("canonical URL parses owner, repo, number", () => {
    const r = parsePrUrl("https://github.com/acme/widget/pull/99");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: "acme", repo: "widget", number: 99 });
  });

  test("URL with trailing path is accepted", () => {
    const r = parsePrUrl("https://github.com/acme/widget/pull/99/files");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.number).toBe(99);
  });

  test("URL with trailing fragment (deep-link paste) is accepted", () => {
    const r = parsePrUrl("https://github.com/acme/widget/pull/99#discussion_r123456");
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value).toEqual({ owner: "acme", repo: "widget", number: 99 });
  });

  test("bare repo URL (no /pull/) is rejected", () => {
    const r = parsePrUrl("https://github.com/acme/widget");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_pr_url");
    expect(r.error.input).toBe("https://github.com/acme/widget");
  });

  test("non-github URL is rejected", () => {
    const r = parsePrUrl("https://gitlab.com/acme/widget/merge_requests/1");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("invalid_pr_url");
  });

  test("empty string is rejected", () => {
    const r = parsePrUrl("");
    expect(r.ok).toBe(false);
  });

  test("plain text is rejected", () => {
    const r = parsePrUrl("not-a-url");
    expect(r.ok).toBe(false);
  });
});

// ── parsePrViewJson — golden samples per PrState kind ────────────────────────

const BASE_THREADS_EMPTY = { nodes: [] };

function makeGolden(overrides: Record<string, unknown>): string {
  return JSON.stringify({
    state: "OPEN",
    merged: false,
    mergedAt: null,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    reviewThreads: BASE_THREADS_EMPTY,
    url: "https://github.com/acme/widget/pull/42",
    ...overrides,
  });
}

describe("parsePrViewJson — already_merged", () => {
  const json = makeGolden({
    state: "MERGED",
    merged: true,
    mergedAt: "2024-06-01T12:00:00Z",
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
  });

  test("kind is already_merged", () => {
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("already_merged");
  });

  test("carries mergedAt and url", () => {
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    const v = r.value as Extract<PrState, { kind: "already_merged" }>;
    expect(v.mergedAt).toBe("2024-06-01T12:00:00Z");
    expect(v.url).toBe("https://github.com/acme/widget/pull/42");
  });
});

describe("parsePrViewJson — open_mergeable_clean", () => {
  const json = makeGolden({});

  test("kind is open_mergeable_clean", () => {
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_mergeable_clean");
  });

  test("carries url", () => {
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    const v = r.value as Extract<PrState, { kind: "open_mergeable_clean" }>;
    expect(v.url).toBe("https://github.com/acme/widget/pull/42");
  });
});

describe("parsePrViewJson — open_mergeable_unresolved", () => {
  const json = makeGolden({
    reviewThreads: {
      nodes: [
        {
          id: "PRRT_abc123",
          isResolved: false,
          comments: {
            nodes: [
              {
                author: { login: "reviewer1" },
                body: "This needs fixing\nMore details below.",
                databaseId: 987654,
              },
            ],
          },
        },
      ],
    },
  });

  test("kind is open_mergeable_unresolved", () => {
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_mergeable_unresolved");
  });

  test("maps thread to ReviewThread shape", () => {
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    const v = r.value as Extract<PrState, { kind: "open_mergeable_unresolved" }>;
    expect(v.threads).toHaveLength(1);
    const t = v.threads[0] as ReviewThread;
    expect(t.id).toBe("PRRT_abc123");
    expect(t.author).toBe("reviewer1");
    expect(t.firstLineSnippet).toBe("This needs fixing");
    expect(t.deepLinkPath).toBe("/pull/42#discussion_r987654");
  });

  test("resolved threads are excluded", () => {
    const withResolved = makeGolden({
      reviewThreads: {
        nodes: [
          {
            id: "PRRT_resolved",
            isResolved: true,
            comments: { nodes: [{ author: { login: "x" }, body: "done", databaseId: 1 }] },
          },
        ],
      },
    });
    // All threads resolved → falls through to open_mergeable_clean
    const r = parsePrViewJson(withResolved);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_mergeable_clean");
  });
});

describe("parsePrViewJson — open_not_mergeable", () => {
  test("CONFLICTING mergeable → reason conflicts", () => {
    const json = makeGolden({ mergeable: "CONFLICTING", mergeStateStatus: "DIRTY" });
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_not_mergeable");
    const v = r.value as Extract<PrState, { kind: "open_not_mergeable" }>;
    expect(v.reason).toBe("conflicts");
  });

  test("BLOCKED mergeStateStatus → reason checks_failing", () => {
    const json = makeGolden({ mergeStateStatus: "BLOCKED" });
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_not_mergeable");
    const v = r.value as Extract<PrState, { kind: "open_not_mergeable" }>;
    expect(v.reason).toBe("checks_failing");
  });

  test("UNSTABLE mergeStateStatus → reason checks_failing", () => {
    const json = makeGolden({ mergeStateStatus: "UNSTABLE" });
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    expect(r.value.kind).toBe("open_not_mergeable");
    const v = r.value as Extract<PrState, { kind: "open_not_mergeable" }>;
    expect(v.reason).toBe("checks_failing");
  });

  test("unknown mergeStateStatus → reason unknown", () => {
    const json = makeGolden({ mergeStateStatus: "BEHIND" });
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    const v = r.value as Extract<PrState, { kind: "open_not_mergeable" }>;
    expect(v.reason).toBe("unknown");
  });
});

describe("parsePrViewJson — closed_unmerged", () => {
  const json = makeGolden({ state: "CLOSED", merged: false });

  test("kind is closed_unmerged", () => {
    const r = parsePrViewJson(json);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.value.kind).toBe("closed_unmerged");
  });

  test("carries url", () => {
    const r = parsePrViewJson(json);
    if (!r.ok) return;
    const v = r.value as Extract<PrState, { kind: "closed_unmerged" }>;
    expect(v.url).toBe("https://github.com/acme/widget/pull/42");
  });
});

describe("parsePrViewJson — schema errors", () => {
  test("invalid JSON string → gh_failed", () => {
    const r = parsePrViewJson("not json{{{");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("gh_failed");
  });

  test("missing required field → gh_failed", () => {
    const r = parsePrViewJson(JSON.stringify({ state: "OPEN" }));
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.error.kind).toBe("gh_failed");
  });
});

// ── narrowGhStderr ────────────────────────────────────────────────────────────

describe("narrowGhStderr", () => {
  const BASE = { exitCode: 1, operation: "fetchPrState", prUrl: "https://github.com/a/b/pull/1" };

  test("'not logged into' → gh_not_authenticated", () => {
    const e = narrowGhStderr({ ...BASE, stderr: "You are not logged into any GitHub hosts. Run gh auth login to authenticate." });
    expect(e.kind).toBe("gh_not_authenticated");
    expect(e.operation).toBe("fetchPrState");
    expect(e.prUrl).toBe(BASE.prUrl);
  });

  test("case-insensitive 'not logged into' match", () => {
    const e = narrowGhStderr({ ...BASE, stderr: "error: Not Logged Into github.com" });
    expect(e.kind).toBe("gh_not_authenticated");
  });

  test("'no pull requests found' → pr_not_found", () => {
    const e = narrowGhStderr({ ...BASE, stderr: "no pull requests found for branch \"main\"" });
    expect(e.kind).toBe("pr_not_found");
  });

  test("'could not find' → pr_not_found", () => {
    const e = narrowGhStderr({ ...BASE, stderr: "could not find pull request matching" });
    expect(e.kind).toBe("pr_not_found");
  });

  test("exit 0 with unrecognised stderr → gh_failed (exitCode 0)", () => {
    const e = narrowGhStderr({ ...BASE, exitCode: 0, stderr: "some unexpected output" });
    expect(e.kind).toBe("gh_failed");
    const f = e as Extract<typeof e, { kind: "gh_failed" }>;
    expect(f.exitCode).toBe(0);
    expect(f.stderr).toBe("some unexpected output");
  });

  test("generic failure carries exitCode and stderr", () => {
    const e = narrowGhStderr({ ...BASE, exitCode: 1, stderr: "API error 500" });
    expect(e.kind).toBe("gh_failed");
    const f = e as Extract<typeof e, { kind: "gh_failed" }>;
    expect(f.exitCode).toBe(1);
    expect(f.stderr).toBe("API error 500");
  });
});
