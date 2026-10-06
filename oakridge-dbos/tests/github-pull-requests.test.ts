import { expect, test } from "bun:test";

import { GithubPullRequestReader } from "../src/runtime/github-pull-requests";

const githubPayload = (overrides: Record<string, unknown> = {}) => ({
  number: 440, html_url: "https://github.com/RankOneLabs/oakridge/pull/440",
  state: "open", merged: false, merged_at: null,
  head: { ref: "cohort/foundation", sha: "abc123" }, base: { ref: "epic/tiers" },
  ...overrides,
});

const readerReturning = (status: number, payload: unknown) => {
  const calls: string[] = [];
  const http = (async (url: string | URL | Request) => {
    calls.push(String(url));
    return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } });
  }) as unknown as typeof fetch;
  return { reader: new GithubPullRequestReader({ token: "test-token" }, http), calls };
};

test("an open pull request reads as open", async () => {
  const { reader, calls } = readerReturning(200, githubPayload());
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("open");
  expect(observation?.source).toBe("poll");
  expect(observation?.head_branch).toBe("cohort/foundation");
  expect(observation?.base_branch).toBe("epic/tiers");
  expect(calls[0]).toBe("https://api.github.com/repos/RankOneLabs/oakridge/pulls/440");
});

/**
 * GitHub reports a merged pull request as `state: "closed"`. Reading the state
 * alone would file every successful merge as a close without merge, which is a
 * mismatch — so the run would refuse the very evidence it is waiting for.
 */
test("a merged pull request reads as merged even though GitHub calls it closed", async () => {
  const { reader } = readerReturning(200, githubPayload({ state: "closed", merged: true, merged_at: "2026-08-18T11:00:00Z" }));
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("merged");
  expect(observation?.merged_at).toBe("2026-08-18T11:00:00Z");
});

test("a pull request closed without merging reads as closed_unmerged", async () => {
  const { reader } = readerReturning(200, githubPayload({ state: "closed", merged: false, merged_at: null }));
  const read = await reader.read("RankOneLabs", "oakridge", 440);
  const observation = read.ok ? read.value : null;
  expect(observation?.state).toBe("closed_unmerged");
});

/**
 * A repository the token cannot see is not evidence of anything. Returning
 * nothing leaves the cohort waiting for the operator, which is the fallback.
 */
test("a pull request that cannot be read yields no observation", async () => {
  const { reader } = readerReturning(404, { message: "Not Found" });
  expect(await reader.read("RankOneLabs", "oakridge", 440)).toEqual({ ok: true, value: null });
});

test("a payload missing the fields an observation needs yields no observation", async () => {
  const { reader } = readerReturning(200, githubPayload({ head: null }));
  expect((await reader.read("RankOneLabs", "oakridge", 440)).ok).toBe(false);
});

test("a GitHub 503 is distinguishable from a missing pull request", async () => {
  const { reader } = readerReturning(503, { message: "Unavailable" });
  expect(await reader.read("RankOneLabs", "oakridge", 440)).toEqual({ ok: false, error: {
    kind: "unavailable", status: 503, detail: "GitHub pull request read failed (503)",
  } });
});

for (const head_owner of ["RankOneLabs", "fork-owner"]) {
  test(`discovery pages through the list and filters the ${head_owner} head repository`, async () => {
    const calls: string[] = [];
    const candidate = { number: 440, head: { ref: "cohort/foundation", repo: { full_name: `${head_owner}/oakridge` } }, base: { ref: "epic/tiers" } };
    const http = (async (input: string | URL | Request) => {
      const url = new URL(String(input));
      calls.push(url.toString());
      if (url.pathname.endsWith("/pulls/440")) return Response.json(githubPayload({ head: candidate.head }));
      if (url.searchParams.get("page") === "1") return Response.json(Array.from({ length: 100 }, (_, number) => ({ ...candidate, number: number + 1, head: { ...candidate.head, repo: { full_name: "other/oakridge" } } })));
      return Response.json([candidate]);
    }) as unknown as typeof fetch;
    const reader = new GithubPullRequestReader({ token: "test-token" }, http);
    const result = await reader.find_for_branches({ owner: "RankOneLabs", name: "oakridge", head_owner, head_branch: "cohort/foundation", base_branch: "epic/tiers" });
    expect(result.ok && result.value.map((item) => item.number)).toEqual([440]);
    expect(calls.some((url) => url.includes(`head=${encodeURIComponent(`${head_owner}:cohort/foundation`)}`) && url.includes("page=2"))).toBe(true);
  });
}
