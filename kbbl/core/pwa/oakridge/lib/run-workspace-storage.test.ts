import { describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import { formatRunWorkspaceHash, readHashRoute } from "../../lib/hash";
import { makeArtifactRevision, makeRunSummary, makeSessionSnapshot } from "../__fixtures__/read-models";

describe("run workspace hash route replacing saved pane arrangement", () => {
  it("namespaces navigation by run ID", () => {
    const first = formatRunWorkspaceHash(makeRunSummary({ run_id: "run-1" }).run_id, null);
    const second = formatRunWorkspaceHash(makeRunSummary({ run_id: "run-2" }).run_id, null);
    expect(first).toBe("oakridge/run/run-1");
    expect(second).not.toBe(first);
  });

  it("opens the run overview when no pane target is in the URL", () => {
    expect(readHashRoute(`#${formatRunWorkspaceHash(makeRunSummary().run_id, null)}`)).toEqual({
      view: "oakridge", route: { sub: "run", id: "run-1", pane: null, scope_id: null },
    });
  });

  it("round-trips a session target without local storage", () => {
    const sid = makeSessionSnapshot("sid-1").sid as Sid;
    expect(readHashRoute(`#${formatRunWorkspaceHash(makeRunSummary().run_id, { kind: "session", session_id: sid })}`)).toEqual({
      view: "oakridge", route: { sub: "run", id: "run-1", pane: { kind: "session", session_id: "sid-1" }, scope_id: null },
    });
  });

  it("round-trips an artifact target with encoded separators", () => {
    const revision = makeArtifactRevision({ id: "revision/one" });
    const route = formatRunWorkspaceHash(makeRunSummary({ run_id: "run/one" }).run_id,
      { kind: "artifact", artifact_id: revision.id as ArtifactId });
    expect(route).toBe("oakridge/run/run%2Fone/artifact/revision%2Fone");
    expect(readHashRoute(`#${route}`)).toEqual({ view: "oakridge", route: {
      sub: "run", id: "run/one", pane: { kind: "artifact", artifact_id: "revision/one" }, scope_id: null,
    } });
  });

  it("keeps an unknown pane suffix at the run overview", () => {
    expect(readHashRoute("#oakridge/run/run-1/terminal/unknown")).toEqual({
      view: "oakridge", route: { sub: "run", id: "run-1", pane: null, scope_id: null },
    });
  });
});
