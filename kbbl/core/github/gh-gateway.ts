import { z } from "zod";

/**
 * Single typed adapter that shells out to the gh CLI. This is the only place
 * in kbbl that spawns gh — centralizes locale pinning, error narrowing, and
 * future auth changes so downstream code only sees typed Result values.
 */

// ── Result type ───────────────────────────────────────────────────────────────

export type Result<T, E> = { ok: true; value: T } | { ok: false; error: E };

// ── Domain error union ────────────────────────────────────────────────────────

export type GhError =
  | { kind: "gh_not_installed"; operation: string; prUrl: string }
  | { kind: "gh_not_authenticated"; operation: string; prUrl: string }
  | { kind: "pr_not_found"; operation: string; prUrl: string }
  | { kind: "gh_failed"; operation: string; prUrl: string; exitCode: number; stderr: string };

// ── parsePrUrl ────────────────────────────────────────────────────────────────

export type ParsedPrUrl = { owner: string; repo: string; number: number };
export type ParseError = { kind: "invalid_pr_url"; input: string };

// Accepts optional trailing path or fragment so operators can paste deep-links.
const PR_URL_RE = /^https:\/\/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/;

export function parsePrUrl(url: string): Result<ParsedPrUrl, ParseError> {
  const m = PR_URL_RE.exec(url);
  if (!m) return { ok: false, error: { kind: "invalid_pr_url", input: url } };
  return {
    ok: true,
    value: { owner: m[1]!, repo: m[2]!, number: parseInt(m[3]!, 10) },
  };
}

// ── Zod schema for gh pr view --json output ───────────────────────────────────

const GhReviewCommentNodeSchema = z.object({
  author: z.object({ login: z.string() }),
  body: z.string(),
  databaseId: z.number().int(),
});

const GhReviewThreadSchema = z.object({
  id: z.string(),
  isResolved: z.boolean(),
  comments: z.object({
    nodes: z.array(GhReviewCommentNodeSchema),
  }),
});

const GhPrViewSchema = z.object({
  state: z.enum(["OPEN", "CLOSED", "MERGED"]),
  merged: z.boolean(),
  mergedAt: z.string().nullable(),
  mergeable: z.enum(["MERGEABLE", "CONFLICTING", "UNKNOWN"]),
  // string (not enum) to survive new GitHub status values without schema breakage
  mergeStateStatus: z.string(),
  reviewDecision: z.string().nullable(),
  reviewThreads: z.object({
    nodes: z.array(GhReviewThreadSchema),
  }),
  url: z.string(),
});

type GhPrView = z.infer<typeof GhPrViewSchema>;

// ── PrState discriminated union ───────────────────────────────────────────────

export type ReviewThread = {
  id: string;
  author: string;
  firstLineSnippet: string;
  /** Path fragment; PWA prefixes with PR URL to compose the full deep-link. */
  deepLinkPath: string;
};

export type PrState =
  | { kind: "already_merged"; mergedAt: string; url: string }
  | { kind: "open_mergeable_clean"; url: string }
  | { kind: "open_mergeable_unresolved"; threads: ReviewThread[]; url: string }
  | { kind: "open_not_mergeable"; reason: "conflicts" | "checks_failing" | "unknown"; url: string }
  | { kind: "closed_unmerged"; url: string };

// ── Internal classification helpers ──────────────────────────────────────────

function extractPrNumber(url: string): number | null {
  const m = /\/pull\/(\d+)/.exec(url);
  return m ? parseInt(m[1]!, 10) : null;
}

function toReviewThread(
  thread: z.infer<typeof GhReviewThreadSchema>,
  prNumber: number,
): ReviewThread | null {
  const comment = thread.comments.nodes[0];
  if (!comment) return null;
  const firstLine = (comment.body.split("\n")[0] ?? "").trim();
  return {
    id: thread.id,
    author: comment.author.login,
    firstLineSnippet: firstLine,
    deepLinkPath: `/pull/${prNumber}#discussion_r${comment.databaseId}`,
  };
}

function classifyPrView(pr: GhPrView): PrState {
  if (pr.merged) {
    return { kind: "already_merged", mergedAt: pr.mergedAt ?? "", url: pr.url };
  }
  if (pr.state === "CLOSED") {
    return { kind: "closed_unmerged", url: pr.url };
  }
  // state === "OPEN"
  const prNumber = extractPrNumber(pr.url) ?? 0;
  const unresolved = pr.reviewThreads.nodes
    .filter((t) => !t.isResolved)
    .map((t) => toReviewThread(t, prNumber))
    .filter((t): t is ReviewThread => t !== null);

  if (unresolved.length > 0) {
    return { kind: "open_mergeable_unresolved", threads: unresolved, url: pr.url };
  }
  if (pr.mergeable === "MERGEABLE" && pr.mergeStateStatus === "CLEAN") {
    return { kind: "open_mergeable_clean", url: pr.url };
  }

  let reason: "conflicts" | "checks_failing" | "unknown" = "unknown";
  if (pr.mergeable === "CONFLICTING" || pr.mergeStateStatus === "DIRTY") {
    reason = "conflicts";
  } else if (pr.mergeStateStatus === "BLOCKED" || pr.mergeStateStatus === "UNSTABLE") {
    reason = "checks_failing";
  }
  return { kind: "open_not_mergeable", reason, url: pr.url };
}

// ── Stderr narrowing (exported for unit tests) ────────────────────────────────

export function narrowGhStderr(opts: {
  exitCode: number;
  stderr: string;
  operation: string;
  prUrl: string;
}): GhError {
  const { exitCode, stderr, operation, prUrl } = opts;
  if (/not logged into/i.test(stderr)) {
    return { kind: "gh_not_authenticated", operation, prUrl };
  }
  // gh exits non-zero and prints "no pull requests found" or "could not find" for 404-style errors
  if (exitCode !== 0 && /no pull requests? found|could not find/i.test(stderr)) {
    return { kind: "pr_not_found", operation, prUrl };
  }
  return { kind: "gh_failed", operation, prUrl, exitCode, stderr };
}

// ── Pure JSON parser ──────────────────────────────────────────────────────────

/**
 * Parses the stdout of `gh pr view --json ...` into a PrState. Pure and
 * synchronous; prUrl in error payloads is empty because the caller (fetchPrState)
 * has that context and the downstream endpoint has it from the request.
 */
export function parsePrViewJson(jsonString: string): Result<PrState, GhError> {
  let raw: unknown;
  try {
    raw = JSON.parse(jsonString);
  } catch {
    return {
      ok: false,
      error: {
        kind: "gh_failed",
        operation: "parsePrViewJson",
        prUrl: "",
        exitCode: 0,
        stderr: "gh stdout was not valid JSON",
      },
    };
  }
  const parsed = GhPrViewSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: {
        kind: "gh_failed",
        operation: "parsePrViewJson",
        prUrl: "",
        exitCode: 0,
        stderr: parsed.error.message,
      },
    };
  }
  return { ok: true, value: classifyPrView(parsed.data) };
}

// ── Spawn helper ──────────────────────────────────────────────────────────────

async function runGh(
  args: string[],
  operation: string,
  prUrl: string,
): Promise<Result<{ stdout: string }, GhError>> {
  let proc: ReturnType<typeof Bun.spawn>;
  try {
    proc = Bun.spawn({
      cmd: ["gh", ...args],
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
  } catch (err) {
    // Bun.spawn throws with code "ENOENT" when the binary is not on PATH
    const isEnoent =
      err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "ENOENT";
    if (isEnoent) {
      return { ok: false, error: { kind: "gh_not_installed", operation, prUrl } };
    }
    throw err;
  }

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);

  if (exitCode !== 0) {
    return {
      ok: false,
      error: narrowGhStderr({ exitCode, stderr, operation, prUrl }),
    };
  }
  return { ok: true, value: { stdout } };
}

// ── Public API ────────────────────────────────────────────────────────────────

const PR_VIEW_FIELDS =
  "state,merged,mergedAt,mergeable,mergeStateStatus,reviewDecision,reviewThreads,url";

export async function fetchPrState(prUrl: string): Promise<Result<PrState, GhError>> {
  const run = await runGh(
    ["pr", "view", prUrl, "--json", PR_VIEW_FIELDS],
    "fetchPrState",
    prUrl,
  );
  if (!run.ok) return run;
  return parsePrViewJson(run.value.stdout);
}

export async function mergePr(prUrl: string): Promise<Result<void, GhError>> {
  const run = await runGh(["pr", "merge", prUrl, "--squash"], "mergePr", prUrl);
  if (!run.ok) return run;
  return { ok: true, value: undefined };
}
