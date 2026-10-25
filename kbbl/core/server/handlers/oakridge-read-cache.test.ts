import { afterEach, describe, expect, test } from "bun:test";
import { createTaggedReadCache } from "./oakridge-read-cache";

const realFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = realFetch; });

/** An upstream that tags every 200 with `etag`, answers 304 to a matching If-None-Match, and records what it was sent. */
function keyedUpstream(state: { etag: string; body: string }) {
  const sent: (string | null)[] = [];
  globalThis.fetch = (async (_input, init) => {
    const tag = (init?.headers as Headers).get("if-none-match");
    sent.push(tag);
    if (tag === state.etag) return new Response(null, { status: 304, headers: { etag: state.etag } });
    return new Response(state.body, { status: 200, headers: { etag: state.etag, "content-type": "application/json" } });
  }) as typeof fetch;
  return sent;
}
const init = () => ({ headers: new Headers(), signal: new AbortController().signal });

describe("createTaggedReadCache", () => {
  test("an unchanged read is answered with the body kept from the first read", async () => {
    keyedUpstream({ etag: 'W/"1"', body: "[1]" });
    const read = createTaggedReadCache();
    await read("http://up/units", init());
    expect(await (await read("http://up/units", init())).text()).toBe("[1]");
  });

  test("a revalidation sends the tag the cache holds", async () => {
    const sent = keyedUpstream({ etag: 'W/"1"', body: "[1]" });
    const read = createTaggedReadCache();
    await read("http://up/units", init());
    await read("http://up/units", init());
    expect(sent).toEqual([null, 'W/"1"']);
  });

  test("a changed read replaces the kept body", async () => {
    const state = { etag: 'W/"1"', body: "[1]" };
    keyedUpstream(state);
    const read = createTaggedReadCache();
    await read("http://up/units", init());
    Object.assign(state, { etag: 'W/"2"', body: "[2]" });
    expect(await (await read("http://up/units", init())).text()).toBe("[2]");
  });

  test("a caller's own If-None-Match is not forwarded for a read the cache does not hold", async () => {
    const sent = keyedUpstream({ etag: 'W/"1"', body: "[1]" });
    const read = createTaggedReadCache();
    await read("http://up/units", { headers: new Headers({ "if-none-match": 'W/"1"' }), signal: new AbortController().signal });
    expect(sent).toEqual([null]);
  });

  test("past its limit the least recently used read is dropped and read in full again", async () => {
    const sent = keyedUpstream({ etag: 'W/"1"', body: "[1]" });
    const read = createTaggedReadCache(1);
    await read("http://up/a", init());
    await read("http://up/b", init());
    await read("http://up/a", init());
    expect(sent).toEqual([null, null, null]);
  });
});
