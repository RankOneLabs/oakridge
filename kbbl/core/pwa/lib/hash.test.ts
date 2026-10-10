import { describe, expect, it } from "vitest";

import {
  formatRunWorkspaceHash,
  readHashRoute,
  readHashSessionTarget,
  readHashPermissionTarget,
  writeHashPermissionTarget,
  writeHashSid,
  writeHashSessionTarget,
} from "./hash";

function withHash(hash: string) {
  window.location.hash = hash;
  return readHashRoute();
}

describe("readHashRoute oakridge routes", () => {
  it("uses Runs as the empty-hash default", () => {
    expect(readHashRoute("", "")).toEqual({
      view: "oakridge",
      route: { sub: "runs" },
    });
  });

  it("routes #sessions to the explicit Sessions surface", () => {
    expect(readHashRoute("#sessions", "")).toEqual({
      view: "sessions",
      route: { sub: "sessions" },
    });
  });

  it("routes a prefill autostart deep link to Sessions", () => {
    expect(readHashRoute("", "?workdir=%2Ftmp%2Fx&autostart=true")).toEqual({
      view: "sessions",
      route: { sub: "sessions" },
    });
  });

  it.each(["plan", "brief", "cohort", "repo", "epic"])("does not expose the retired %s route", (view) => {
    expect(withHash(`#${view}/old-id`)).toBeNull();
  });

  it("matches only the oakridge path segment", () => {
    expect(withHash("#oakridge")).toEqual({
      view: "oakridge",
      route: { sub: "runs" },
    });
    expect(withHash("#oakridge/run/run-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", scope_id: null, pane: null },
    });
    expect(withHash("#oakridge/def/def%2F1")).toEqual({
      view: "oakridge",
      route: { sub: "def", id: "def/1" },
    });
    expect(withHash("#oakridge/review-inbox")).toEqual({
      view: "oakridge",
      route: { sub: "review-inbox" },
    });
    expect(withHash("#oakridgeSomethingElse")).toBeNull();
  });
});

describe("run scope routes", () => {
  it("parses a run route that names a scope", () => {
    expect(withHash("#oakridge/run/run-1/scope/scope-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", scope_id: "scope-1", pane: null },
    });
  });

  it("opens a session pane within its run", () => {
    expect(withHash("#oakridge/run/run-1/session/sid-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", scope_id: null, pane: { kind: "session", session_id: "sid-1" } },
    });
  });

  const ROUND_TRIPS: ReadonlyArray<readonly [string, string, string | null]> = [
    ["a bare run", "run-1", null],
    ["a scope", "run-1", "scope-1"],
    // Both halves need encoding: an id containing a slash would otherwise read
    // as an extra path segment and shift every segment after it.
    ["ids that need URL encoding", "run/one", "scope/one"],
  ];

  it.each(ROUND_TRIPS)("round-trips %s", (_label, runId, scopeId) => {
    expect(withHash(`#${formatRunWorkspaceHash(runId, scopeId)}`)).toEqual({
      view: "oakridge",
      route: { sub: "run", id: runId, scope_id: scopeId, pane: null },
    });
  });

  it("round-trips an artifact pane and both project routes", () => {
    expect(withHash(`#${formatRunWorkspaceHash("run/one", { kind: "artifact", artifact_id: "revision/one" as never })}`))
      .toEqual({ view: "oakridge", route: { sub: "run", id: "run/one", scope_id: null,
        pane: { kind: "artifact", artifact_id: "revision/one" } } });
    expect(withHash("#oakridge/create-project")).toEqual({ view: "oakridge", route: { sub: "create-project" } });
    expect(withHash("#oakridge/projects")).toEqual({ view: "oakridge", route: { sub: "projects" } });
  });
});

describe("session targets", () => {
  it("returns from a session to the explicit Sessions surface", () => {
    window.location.hash = "#sid=session-one";
    writeHashSid(null);

    expect(window.location.hash).toBe("#sessions");
    expect(readHashRoute()).toEqual({
      view: "sessions",
      route: { sub: "sessions" },
    });
  });

  it("links a pending-approval alert to the approval location in its session", () => {
    writeHashSessionTarget("sid/one", "pending-permission");

    expect(window.location.hash).toBe("#sid=sid%2Fone&focus=pending-permission");
    expect(readHashSessionTarget()).toBe("pending-permission");
  });

  it("preserves the exact permission request in a session link", () => {
    writeHashPermissionTarget("sid/one", "request/second");

    expect(window.location.hash).toBe("#sid=sid%2Fone&focus=permission&requestId=request%2Fsecond");
    expect(readHashPermissionTarget()).toBe("request/second");
  });
});
