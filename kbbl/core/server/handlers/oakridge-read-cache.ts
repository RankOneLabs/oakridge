/** A read the upstream tagged, kept so the next poll can revalidate it instead of re-reading it. */
interface TaggedRead {
  readonly etag: string;
  readonly body: string;
  readonly content_type: string;
}

/** What a server-side upstream read needs; the cache owns the conditional header. */
export interface UpstreamReadInit {
  readonly headers: Headers;
  readonly signal: AbortSignal;
}

export type UpstreamRead = (url: string, init: UpstreamReadInit) => Promise<Response>;

/** The most reads kept; the least recently used goes first, and a dropped read costs one full read. */
const MAX_TAGGED_READS = 2_000;

const answerFrom = (read: TaggedRead): Response =>
  new Response(read.body, { status: 200, headers: { "content-type": read.content_type, etag: read.etag } });

/**
 * Server-side fetch has no HTTP cache, so kbbl holds the tags itself: each read
 * sends the tag it holds, and a 304 is answered with the body kept for it.
 */
export function createTaggedReadCache(limit: number = MAX_TAGGED_READS): UpstreamRead {
  const reads = new Map<string, TaggedRead>();
  const keep = (url: string, read: TaggedRead): void => {
    reads.delete(url);
    reads.set(url, read);
    for (const oldest of reads.keys()) {
      if (reads.size <= limit) break;
      reads.delete(oldest);
    }
  };
  return async (url, init) => {
    const held = reads.get(url);
    const headers = new Headers(init.headers);
    if (held) headers.set("if-none-match", held.etag);
    else headers.delete("if-none-match");
    const response = await fetch(url, { headers, signal: init.signal });
    if (response.status === 304 && held) {
      keep(url, held);
      return answerFrom(held);
    }
    const etag = response.headers.get("etag");
    if (response.status !== 200 || etag === null) {
      reads.delete(url);
      return response;
    }
    const read: TaggedRead = { etag, body: await response.text(), content_type: response.headers.get("content-type") ?? "application/json" };
    keep(url, read);
    return answerFrom(read);
  };
}
