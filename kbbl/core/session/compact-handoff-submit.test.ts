import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createSafirClient,
  type FetchFn,
  type SafirClient,
} from "../safir/client";
import { createSafirQueue, type SafirQueue } from "../safir/queue";
import type { HandoffDoc } from "./handoff-doc";
import { submitCompactionHandoff } from "./compact-handoff-submit";

let tmpRoot: string;

interface StubCall {
  method: string;
  path: string;
  body: unknown;
}

function makeSafirStub(opts: {
  status?: number;
  responseBody?: unknown;
  throwOnFetch?: boolean | (() => Error);
}): { fetch: FetchFn; calls: StubCall[] } {
  const calls: StubCall[] = [];
  const fetchFn: FetchFn = async (input, init) => {
    if (opts.throwOnFetch) {
      const make =
        typeof opts.throwOnFetch === "function"
          ? opts.throwOnFetch
          : () => new TypeError("safir down");
      throw make();
    }
    const url = typeof input === "string" ? input : (input as Request).url;
    const path = url.replace(/^https?:\/\/[^/]+/, "");
    const method = (init?.method ?? "GET").toUpperCase();
    const bodyText = typeof init?.body === "string" ? init.body : null;
    const body = bodyText ? (JSON.parse(bodyText) as unknown) : null;
    calls.push({ method, path, body });
    const status = opts.status ?? 201;
    const respBody = opts.responseBody ?? {
      id: "h-stub-1",
      phase_id: "p-stub",
      run_id: "r-stub",
      role: "phase_output",
      schema_version: 1,
      goal: "g",
      active_subgoals: [],
      decisions_made: [],
      approaches_rejected: [],
      files_in_scope: [],
      open_questions: [],
      next_action: null,
      raw_markdown: "# stub\n",
      produced_at: "2026-05-09T00:00:00.000Z",
    };
    return Response.json(respBody, { status });
  };
  return { fetch: fetchFn, calls };
}

function makeDeps(fetchFn: FetchFn): {
  safirClient: SafirClient;
  safirQueue: SafirQueue;
} {
  const safirClient = createSafirClient({
    baseUrl: "http://safir.test",
    fetch: fetchFn,
  });
  const safirQueue = createSafirQueue({ dataDir: tmpRoot });
  return { safirClient, safirQueue };
}

function makeHandoff(over: Partial<HandoffDoc> = {}): HandoffDoc {
  return {
    schema_version: 1,
    task_id: 42,
    run_id: "r-1",
    from_session_id: "old-sid",
    to_session_id: null,
    produced_at: "2026-05-09T00:00:00.000Z",
    goal: "carry forward the build plan",
    active_subgoals: ["finish step 5"],
    decisions_made: [
      { decision: "use safirCall", rationale: "5xx queue + 4xx throw" },
    ],
    approaches_rejected: [
      {
        approach: "imperative createPhase",
        reason: "duplicates openSafirContext",
      },
    ],
    files_in_scope: ["kbbl/core/session/session-manager.ts"],
    open_questions: ["does PR-3 emit compact_completed?"],
    next_action: "wire submitCompactionHandoff",
    raw_markdown: "# handoff\n\nbody",
    ...over,
  };
}

const queuePath = (root: string) => join(root, "safir-queue.jsonl");

const originalConsoleError = console.error;
beforeEach(() => {
  tmpRoot = mkdtempSync(join(tmpdir(), "kbbl-compact-handoff-test-"));
  mkdirSync(tmpRoot, { recursive: true });
  console.error = () => {};
});
afterEach(() => {
  console.error = originalConsoleError;
  rmSync(tmpRoot, { recursive: true, force: true });
});

describe("submitCompactionHandoff happy path", () => {
  test("POSTs to /phases/<id>/handoff with raw_markdown + parsed", async () => {
    const stub = makeSafirStub({});
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff({ goal: "specific goal" });

    await submitCompactionHandoff(deps, "p-42", handoff);

    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]!.method).toBe("POST");
    expect(stub.calls[0]!.path).toBe("/phases/p-42/handoff");
    expect(stub.calls[0]!.body).toEqual({
      raw_markdown: handoff.raw_markdown,
      parsed: {
        goal: "specific goal",
        active_subgoals: handoff.active_subgoals,
        decisions_made: handoff.decisions_made,
        approaches_rejected: handoff.approaches_rejected,
        files_in_scope: handoff.files_in_scope,
        open_questions: handoff.open_questions,
        next_action: handoff.next_action,
      },
    });
  });

  test("identity copy of all seven parsed fields", async () => {
    const stub = makeSafirStub({});
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);
    const body = stub.calls[0]!.body as { parsed: Record<string, unknown> };
    expect(Object.keys(body.parsed).sort()).toEqual([
      "active_subgoals",
      "approaches_rejected",
      "decisions_made",
      "files_in_scope",
      "goal",
      "next_action",
      "open_questions",
    ]);
    expect(body.parsed.goal).toBe(handoff.goal);
    expect(body.parsed.active_subgoals).toEqual(handoff.active_subgoals);
    expect(body.parsed.decisions_made).toEqual(handoff.decisions_made);
    expect(body.parsed.approaches_rejected).toEqual(handoff.approaches_rejected);
    expect(body.parsed.files_in_scope).toEqual(handoff.files_in_scope);
    expect(body.parsed.open_questions).toEqual(handoff.open_questions);
    expect(body.parsed.next_action).toBe(handoff.next_action);
  });

  test("raw_markdown forwarded verbatim including newlines and special chars", async () => {
    const stub = makeSafirStub({});
    const deps = makeDeps(stub.fetch);
    const md =
      "# Goal\n\nLine with \"quotes\" and `backticks` and emoji 🚀\n\nLine 2\n";
    const handoff = makeHandoff({ raw_markdown: md });

    await submitCompactionHandoff(deps, "p-42", handoff);
    const body = stub.calls[0]!.body as { raw_markdown: string };
    expect(body.raw_markdown).toBe(md);
  });
});

describe("submitCompactionHandoff transient failures", () => {
  test("queues request when safir returns 5xx", async () => {
    const stub = makeSafirStub({ status: 503, responseBody: { error: "down" } });
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);

    const queueContents = readFileSync(queuePath(tmpRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(queueContents).toHaveLength(1);
    expect(queueContents[0].request.path).toBe("/phases/p-42/handoff");
    expect(queueContents[0].delivered_at).toBeUndefined();
  });

  test("queues request on network failure (TypeError)", async () => {
    const stub = makeSafirStub({ throwOnFetch: true });
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);

    const queueContents = readFileSync(queuePath(tmpRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(queueContents).toHaveLength(1);
  });

  test("queues request on AbortError (timeout)", async () => {
    const stub = makeSafirStub({
      throwOnFetch: () => {
        const e = new Error("aborted");
        e.name = "AbortError";
        return e;
      },
    });
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);

    const queueContents = readFileSync(queuePath(tmpRoot), "utf8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l));
    expect(queueContents).toHaveLength(1);
  });
});

describe("submitCompactionHandoff permanent failures", () => {
  test("4xx is swallowed; no queue entry written", async () => {
    const stub = makeSafirStub({
      status: 404,
      responseBody: { error: "no such phase" },
    });
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);

    const queueExists = existsSync(queuePath(tmpRoot));
    if (queueExists) {
      const contents = readFileSync(queuePath(tmpRoot), "utf8");
      expect(contents.trim()).toBe("");
    }
  });

  test("422 is also swallowed", async () => {
    const stub = makeSafirStub({
      status: 422,
      responseBody: { error: "schema mismatch" },
    });
    const deps = makeDeps(stub.fetch);
    const handoff = makeHandoff();

    await submitCompactionHandoff(deps, "p-42", handoff);

    const queueExists = existsSync(queuePath(tmpRoot));
    if (queueExists) {
      const contents = readFileSync(queuePath(tmpRoot), "utf8");
      expect(contents.trim()).toBe("");
    }
  });
});
