import type { Hono } from "hono";
import type { ExecutedPromptTurn } from "../../executed-prompt";
import { isValidControlRequest } from "../../../../oakridge-dbos/src/http/control-auth";
import { configuredBrowserWritePolicy } from "../../../../oakridge-dbos/src/http/browser-write-policy";

interface ExecutedPromptReader {
  readPromptTurns(sid: string): readonly ExecutedPromptTurn[] | null;
}
interface ExecutedPromptDeps { readonly acp: ExecutedPromptReader; readonly browserControlToken?: string }

/** Capture all retained credentials first, then redact across the entire session. */
export function redactPublicationSecret(turns: readonly ExecutedPromptTurn[]): ExecutedPromptTurn[] {
  const secrets = [...new Set(turns.flatMap(({ text }) => [
    ...text.matchAll(/^[\t ]*Your publication secret:[\t ]*(\S+)[\t ]*\r?$/gm),
    ...text.matchAll(/Authorization:[\t ]*Bearer[\t ]+(\S+)/gi),
  ].flatMap((match) => match[1] ? [match[1]] : [])))].sort((left, right) => right.length - left.length);
  return turns.map((turn) => ({ ...turn, text: secrets.reduce(
    (text, secret) => text.split(secret).join("[redacted]"), turn.text,
  ) }));
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
      return c.json(redactPublicationSecret(turns));
    } catch {
      return c.json({ error: { code: "unavailable" } }, 503);
    }
  });
}
