import { expect, test } from "bun:test";

import { GithubPullRequestReader, selectPullRequest } from "../src/runtime/github-pull-requests";

const githubPayload = (overrides: Record<string, unknown> = {}) => ({
  number: 440, html_url: "https://github.com/RankOneLabs/oakridge/pull/440",
  state: "open", merged: false, merged_at: null,
  head: { ref: "cohort/foundation", sha: "abc123", repo: { full_name: "RankOneLabs/oakridge" } }, base: { ref: "epic/tiers" },
  ...overrides,
});

const readerReturning = (status: number, payload: unknown, headers: Record<string, string> = {}) => {
  const calls: string[] = [];
  const http = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json", ...headers } });
  }) as unknown as typeof fetch;
  return { reader: new GithubPullRequestReader({ token: "test-token" }, http), calls };
};

const ref = { owner: "RankOneLabs", name: "oakridge", number: 440 };

test("an open pull request reads as open, with its head and base", () => {
  const pull_request = selectPullRequest(githubPayload());
  expect(pull_request && [pull_request.state, pull_request.head_owner, pull_request.head_branch, pull_request.base_branch])
    .toEqual(["open", "RankOneLabs", "cohort/foundation", "epic/tiers"]);
});

/**
 * GitHub reports a merged pull request as `state: "closed"`. Reading the state
 * alone would file every successful merge as a close without merge, which is a
 * mismatch — so the run would refuse the very evidence it is waiting for.
 */
test("a merged pull request reads as merged even though GitHub calls it closed", () => {
  const pull_request = selectPullRequest(githubPayload({ state: "closed", merged: true, merged_at: "2026-08-18T11:00:00Z" }));
  expect(pull_request && [pull_request.state, pull_request.merged_at]).toEqual(["merged", "2026-08-18T11:00:00Z"]);
});

test("a pull request closed without merging reads as closed_unmerged", () => {
  expect(selectPullRequest(githubPayload({ state: "closed", merged: false, merged_at: null }))?.state).toBe("closed_unmerged");
});

test("a pull request whose head repository is gone reads with no head owner", () => {
  expect(selectPullRequest(githubPayload({ head: { ref: "cohort/foundation", sha: "abc123", repo: null } }))?.head_owner).toBeNull();
});

test("a payload missing the fields an observation needs yields no pull request", () => {
  expect(selectPullRequest(githubPayload({ head: null }))).toBeNull();
});

test("the reader fetches the pull request by number", async () => {
  const { reader, calls } = readerReturning(200, githubPayload({ state: "closed", merged: true, merged_at: "2026-08-18T11:00:00Z" }));
  const found = await reader.get(ref);
  expect({ calls, state: found.ok ? found.value?.state : null })
    .toEqual({ calls: ["https://api.github.com/repos/RankOneLabs/oakridge/pulls/440"], state: "merged" });
});

test("a 404 is no such pull request, not an error", async () => {
  const { reader } = readerReturning(404, { message: "Not Found" });
  expect(await reader.get(ref)).toEqual({ ok: true, value: null });
});

test("a GitHub 503 is unavailable", async () => {
  const { reader } = readerReturning(503, { message: "Unavailable" });
  const found = await reader.get(ref);
  expect(found.ok ? null : [found.error.kind, found.error.status]).toEqual(["unavailable", 503]);
});

/** GitHub answers a primary or secondary rate limit with 403; it passes, so the observation is retried, not failed as auth. */
for (const [limit, headers] of [["primary", { "x-ratelimit-remaining": "0" }], ["secondary", { "retry-after": "60" }]] as const) {
  test(`a 403 for a ${limit} rate limit is unavailable, not an auth failure`, async () => {
    const { reader } = readerReturning(403, { message: "API rate limit exceeded" }, headers);
    const found = await reader.get(ref);
    expect(found.ok ? null : found.error.kind).toBe("unavailable");
  });
}

test("a 403 that is not a rate limit is an auth failure", async () => {
  const { reader } = readerReturning(403, { message: "Resource not accessible by integration" }, { "x-ratelimit-remaining": "4999" });
  const found = await reader.get(ref);
  expect(found.ok ? null : found.error.kind).toBe("auth");
});

test("a pull request body missing its fields is unavailable", async () => {
  const { reader } = readerReturning(200, githubPayload({ html_url: null }));
  const found = await reader.get(ref);
  expect(found.ok ? null : found.error.kind).toBe("unavailable");
});

test("a pull request carries no read time, so the same pull request read twice is the same", async () => {
  const { reader } = readerReturning(200, githubPayload());
  const first = await reader.get(ref);
  await Bun.sleep(5);
  expect(await reader.get(ref)).toEqual(first);
});
