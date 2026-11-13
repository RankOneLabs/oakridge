import type { Hono } from "hono";
import type { ExecutedPromptTurn } from "../../executed-prompt";
import type { RetainedPromptTurn } from "../../acp/store-turns";
import { isValidControlRequest } from "../../../../oakridge-dbos/src/http/control-auth";
import { configuredBrowserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";

interface ExecutedPromptReader {
  readPromptTurns(sid: string): readonly RetainedPromptTurn[] | null;
}
interface ExecutedPromptDeps { readonly acp: ExecutedPromptReader; readonly browserControlToken?: string }

/** Capture all retained credentials first, then redact across the entire session. */
export function redactPublicationSecret<Turn extends ExecutedPromptTurn>(turns: readonly Turn[]): Turn[] {
  const secrets = [...new Set(turns.flatMap(({ text }) => [
    ...text.matchAll(/^[\t ]*Your publication secret:[\t ]*(\S+)[\t ]*\r?$/gm),
    ...text.matchAll(/Authorization:[\t ]*Bearer[\t ]+(\S+)/gi),
  ].flatMap((match) => match[1] ? [match[1]] : [])))].sort((left, right) => right.length - left.length);
  return turns.map((turn) => ({ ...turn, text: secrets.reduce(
    (text, secret) => text.split(secret).join("[redacted]"), turn.text,
  ) }));
}

/** started_at is persisted before dispatch; its absence means the payload never reached that boundary. */
export function selectDispatchedPromptTurns(turns: readonly RetainedPromptTurn[]): ExecutedPromptTurn[] {
  return turns.filter((turn) => turn.started_at !== null).map(({ turn_id, created_at, text }) => ({ turn_id, created_at, text }));
}

/** Payloads and IO error details must never be logged or put in errors. */
export function mountExecutedPromptRoutes(app: Hono, deps: ExecutedPromptDeps): void {
  const policy = configuredBrowserWritePolicy();
  app.get("/oakridge/sessions/:kbbl_session_id/executed-prompt", (c) => {
    c.header("cache-control", "no-store");
    if (deps.browserControlToken && !isValidControlRequest(c.req.raw, deps.browserControlToken, policy))
      return c.json({ error: { code: "unauthorized" } }, 401);
    try {
      const turns = deps.acp.readPromptTurns(c.req.param("kbbl_session_id"));
      if (!turns?.length) return c.json({ error: { code: "not_retained" } }, 404);
      // Capture credentials from every retained turn, including a queued preamble, before excluding it.
      const executed = selectDispatchedPromptTurns(redactPublicationSecret(turns));
      if (executed.length === 0) return c.json({ error: { code: "not_retained" } }, 404);
      return c.json(executed);
    } catch {
      return c.json({ error: { code: "unavailable" } }, 503);
    }
  });
}
