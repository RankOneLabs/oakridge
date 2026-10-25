import type { Context, MiddlewareHandler } from "hono";
import type { ReadChangeKey } from "../storage/read-store";
import { fault } from "./errors";

/** Every restart re-tags every read: a deploy can change a projection without changing its rows. */
const PROCESS_EPOCH = Date.now().toString(36);
/** The browser keeps the body but asks again on every read, sending the tag it holds. */
const REVALIDATE = "private, no-cache";

/** The entity tag a read carries for one change key. */
export const selectEntityTag = (key: ReadChangeKey, epoch: string = PROCESS_EPOCH): string => `W/"${epoch}.${key}"`;

/** Whether an If-None-Match header names this tag. */
export function isTagCurrent(if_none_match: string | undefined, tag: string): boolean {
  return if_none_match !== undefined && if_none_match.split(",").some((candidate) => candidate.trim() === tag);
}

/**
 * Answers a GET with 304 when the caller already holds the current read,
 * before the read runs; otherwise tags the read's 200. A missing subject reads
 * on to its own 404.
 */
export const changeKeyed = (keyOf: (context: Context) => Promise<ReadChangeKey | null>): MiddlewareHandler => async (context, next) => {
  if (context.req.method !== "GET") return next();
  let key: ReadChangeKey | null;
  try { key = await keyOf(context); } catch (cause) { return fault(cause); }
  if (key === null) return next();
  const tag = selectEntityTag(key);
  if (isTagCurrent(context.req.header("if-none-match"), tag)) return context.body(null, 304, { etag: tag, "cache-control": REVALIDATE });
  await next();
  if (context.res.status !== 200) return;
  context.res.headers.set("etag", tag);
  context.res.headers.set("cache-control", REVALIDATE);
};
