import { expect, test } from "bun:test";

import { PROVIDER_ERROR_CODES } from "../src/effects/provider-catalog";
import { observePullRequest, selectDevelopmentMergeQuery, selectPullRequestRef, type PullRequestWatchQuery } from "../src/operations/pull-request-observe";
import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";

const query: PullRequestWatchQuery = { owner: "RankOneLabs", name: "oakridge", head_owner: "RankOneLabs",
  head_branch: "cohort/foundation", base_branch: "epic/tiers", pr_url: "https://github.com/RankOneLabs/oakridge/pull/440" };

const githubPayload = (overrides: Record<string, unknown> = {}) => ({
  number: 440, html_url: "https://github.com/RankOneLabs/oakridge/pull/440",
  state: "open", merged: false, merged_at: null,
  head: { ref: "cohort/foundation", sha: "abc123", repo: { full_name: "RankOneLabs/oakridge" } }, base: { ref: "epic/tiers" },
  ...overrides,
});

/** A forge that answers every pull request read with `payload` (or 404 for null), recording each url read. */
const forgeReturning = (payload: unknown) => {
  const calls: string[] = [];
  const http = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return payload === null ? new Response(JSON.stringify({ message: "Not Found" }), { status: 404 }) : Response.json(payload);
  }) as unknown as typeof fetch;
  return { reader: new GithubPullRequestReader({ token: "test-token" }, http), calls };
};

const refFor = (pr_url: string) => selectPullRequestRef({ ...query, pr_url });

test("merge confirmation checks the current PR against the unit's intended base", () => {
  const input = { repository: { forge: { owner: "RankOneLabs", name: "oakridge", build_base: "develop", final_base: "main" } },
    workspace: { push_remote_owner: "RankOneLabs" } };
  const pr = { pr_url: query.pr_url, branch: "cohort/foundation" };
  expect([selectDevelopmentMergeQuery("cohort", input, pr), selectDevelopmentMergeQuery("integration", input, pr)])
    .toEqual([{ ok: true, value: { ...query, base_branch: "develop" } }, { ok: true, value: { ...query, base_branch: "main" } }]);
});

test("merge confirmation refuses a missing current PR identity", () => {
  expect(selectDevelopmentMergeQuery("cohort", {}, null).ok).toBe(false);
});

test("a pull request url names its number in the query's repository", () => {
  expect(refFor("https://github.com/RankOneLabs/oakridge/pull/440"))
    .toEqual({ ok: true, value: { owner: "RankOneLabs", name: "oakridge", number: 440 } });
});

test("a trailing slash, query or fragment does not change the pull request a url names", () => {
  expect(["https://github.com/RankOneLabs/oakridge/pull/440/", "https://github.com/RankOneLabs/oakridge/pull/440?w=1",
    "https://github.com/RankOneLabs/oakridge/pull/440#discussion_r1"].map((url) => {
    const ref = refFor(url);
    return ref.ok ? ref.value.number : ref.error;
  })).toEqual([440, 440, 440]);
});

test("the repository in a url compares without case", () => {
  expect(refFor("https://github.com/rankonelabs/OAKRIDGE/pull/440").ok).toBe(true);
});

test("a url in another repository names no pull request of the query's", () => {
  expect(refFor("https://github.com/RankOneLabs/elsewhere/pull/440"))
    .toEqual({ ok: false, error: "pr_url https://github.com/RankOneLabs/elsewhere/pull/440 is in RankOneLabs/elsewhere, not RankOneLabs/oakridge" });
});

test("a url that is not a pull request url is refused", () => {
  expect(["https://github.com/RankOneLabs/oakridge/issues/440", "https://github.com/RankOneLabs/oakridge/pull/abc",
    "https://github.com/RankOneLabs/oakridge/pull/440/files", "http://github.com/RankOneLabs/oakridge/pull/440",
    "https://forge.test/RankOneLabs/oakridge/pull/440", "pull 440"].map((url) => refFor(url).ok))
    .toEqual([false, false, false, false, false, false]);
});

for (const [github, expected] of [
  [{}, "open"],
  [{ state: "closed", merged: true, merged_at: "2026-08-18T11:00:00Z" }, "merged"],
  [{ state: "closed", merged: false }, "closed_unmerged"],
] as const) {
  test(`the pull request the url names observes as ${expected}`, async () => {
    const { reader, calls } = forgeReturning(githubPayload(github));
    const outcome = await observePullRequest(reader, { query });
    expect({ calls, outcome }).toEqual({ calls: ["https://api.github.com/repos/RankOneLabs/oakridge/pulls/440"], outcome: { kind: "succeeded",
      body: { state: expected, number: 440, url: "https://github.com/RankOneLabs/oakridge/pull/440", head_sha: "abc123",
        merged_at: expected === "merged" ? "2026-08-18T11:00:00Z" : null } } });
  });
}

test("a url that names no pull request of the repository fails as a mismatch, without reading the forge", async () => {
  const { reader, calls } = forgeReturning(githubPayload());
  const outcome = await observePullRequest(reader, { query: { ...query, pr_url: "https://github.com/other/oakridge/pull/440" } });
  expect({ calls: calls.length, code: outcome.kind === "failed" ? outcome.code : outcome.kind })
    .toEqual({ calls: 0, code: PROVIDER_ERROR_CODES.pull_request_mismatch });
});

test("a pull request the forge does not have fails as a mismatch", async () => {
  const outcome = await observePullRequest(forgeReturning(null).reader, { query });
  expect(outcome).toEqual({ kind: "failed", code: PROVIDER_ERROR_CODES.pull_request_mismatch, detail: "RankOneLabs/oakridge has no pull request #440" });
});

for (const [what, github, detail] of [
  ["head branch", { head: { ref: "cohort/other", sha: "abc123", repo: { full_name: "RankOneLabs/oakridge" } } },
    "pull request #440 has head RankOneLabs:cohort/other, not RankOneLabs:cohort/foundation"],
  ["head owner", { head: { ref: "cohort/foundation", sha: "abc123", repo: { full_name: "fork-owner/oakridge" } } },
    "pull request #440 has head fork-owner:cohort/foundation, not RankOneLabs:cohort/foundation"],
  ["base branch", { base: { ref: "main" } }, "pull request #440 has base main, not epic/tiers"],
] as const) {
  test(`a pull request with another ${what} fails as a mismatch naming it`, async () => {
    expect(await observePullRequest(forgeReturning(githubPayload(github)).reader, { query }))
      .toEqual({ kind: "failed", code: PROVIDER_ERROR_CODES.pull_request_mismatch, detail });
  });
}

test("a fork's head owner compares without case, whatever its repository is now called", async () => {
  const fork = githubPayload({ head: { ref: "cohort/foundation", sha: "abc123", repo: { full_name: "Fork-Owner/oakridge-renamed" } } });
  const outcome = await observePullRequest(forgeReturning(fork).reader, { query: { ...query, head_owner: "fork-owner" } });
  expect(outcome.kind).toBe("succeeded");
});

test("an unavailable forge is unavailable, to be retried", async () => {
  const http = (async () => new Response("down", { status: 503 })) as unknown as typeof fetch;
  expect((await observePullRequest(new GithubPullRequestReader({ token: "t" }, http), { query })).kind).toBe("unavailable");
});
