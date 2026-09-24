import { describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "./ids";
import {
  formatRunWorkspaceHash,
  readHashRoute,
  readHashSessionTarget,
  writeHashSessionTarget,
} from "./hash";
import type { RoutePaneTarget } from "../oakridge/lib/run-workspace";

function withHash(hash: string) {
  window.location.hash = hash;
  return readHashRoute();
}

describe("readHashRoute oakridge routes", () => {
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
      route: { sub: "run", id: "run-1", pane: null },
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

describe("run workspace pane routes", () => {
  it("parses a run route that names a session pane", () => {
    expect(withHash("#oakridge/run/run-1/session/sid-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", pane: { kind: "session", session_id: "sid-1" } },
    });
  });

  it("parses a run route that names an artifact pane", () => {
    expect(withHash("#oakridge/run/run-1/artifact/art-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", pane: { kind: "artifact", artifact_id: "art-1" } },
    });
  });

  it("falls back to a bare run route for an unknown pane kind", () => {
    expect(withHash("#oakridge/run/run-1/terminal/t-1")).toEqual({
      view: "oakridge",
      route: { sub: "run", id: "run-1", pane: null },
    });
  });

  it("parses the standalone session route", () => {
    expect(withHash("#oakridge/session/sid-1")).toEqual({
      view: "oakridge",
      route: { sub: "session", session_id: "sid-1" },
    });
  });

  it("keeps the standalone artifact route resolving", () => {
    expect(withHash("#oakridge/artifact/art-1")).toEqual({
      view: "oakridge",
      route: { sub: "artifact", id: "art-1" },
    });
  });

  const ROUND_TRIPS: ReadonlyArray<readonly [string, string, RoutePaneTarget | null]> = [
    ["a bare run", "run-1", null],
    ["a session pane", "run-1", { kind: "session", session_id: "sid-1" as Sid }],
    ["an artifact pane", "run-1", { kind: "artifact", artifact_id: "art-1" as ArtifactId }],
    // Both halves need encoding: an id containing a slash would otherwise read
    // as an extra path segment and shift every segment after it.
    ["ids that need URL encoding", "run/one", { kind: "session", session_id: "sid/one" as Sid }],
    ["an artifact id that needs URL encoding", "run-1", { kind: "artifact", artifact_id: "art one/2" as ArtifactId }],
  ];

  it.each(ROUND_TRIPS)("round-trips %s", (_label, runId, pane) => {
    expect(withHash(`#${formatRunWorkspaceHash(runId, pane)}`)).toEqual({
      view: "oakridge",
      route: { sub: "run", id: runId, pane },
    });
  });

  it("encodes a session id that needs it rather than emitting a raw slash", () => {
    expect(formatRunWorkspaceHash("run-1", { kind: "session", session_id: "sid/one" as Sid })).toBe(
      "oakridge/run/run-1/session/sid%2Fone",
    );
  });
});

describe("session targets", () => {
  it("links a pending-approval alert to the approval location in its session", () => {
    writeHashSessionTarget("sid/one", "pending-permission");

    expect(window.location.hash).toBe("#sid=sid%2Fone&focus=pending-permission");
    expect(readHashSessionTarget()).toBe("pending-permission");
  });
});
