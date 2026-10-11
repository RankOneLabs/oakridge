import { describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import { formatRunWorkspaceHash, readHashRoute } from "../../lib/hash";
import { makeArtifactRevision, makeRunSummary, makeSessionSnapshot } from "../__fixtures__/read-models";

describe("single route pane replacing twin workspace state", () => {
  const run = makeRunSummary();
  const session = makeSessionSnapshot("sid-1");
  const revision = makeArtifactRevision();

  it("opens a bare run at its overview", () => {
    expect(readHashRoute(`#${formatRunWorkspaceHash(run.run_id, null)}`)).toEqual({
      view: "oakridge", route: { sub: "run", id: run.run_id, pane: null, scope_id: null },
    });
  });

  it("addresses a session as the selected pane", () => {
    expect(readHashRoute(`#${formatRunWorkspaceHash(run.run_id, { kind: "session", session_id: session.sid as Sid })}`))
      .toEqual({ view: "oakridge", route: { sub: "run", id: run.run_id,
        pane: { kind: "session", session_id: session.sid }, scope_id: null } });
  });

  it("addresses an artifact as the selected pane", () => {
    expect(readHashRoute(`#${formatRunWorkspaceHash(run.run_id, { kind: "artifact", artifact_id: revision.id as ArtifactId })}`))
      .toEqual({ view: "oakridge", route: { sub: "run", id: run.run_id,
        pane: { kind: "artifact", artifact_id: revision.id }, scope_id: null } });
  });

  it("keeps artifact and session targets distinct even when their IDs match", () => {
    const sid = makeSessionSnapshot("same").sid as Sid;
    const artifactId = makeArtifactRevision({ id: "same" }).id as ArtifactId;
    expect(formatRunWorkspaceHash(run.run_id, { kind: "session", session_id: sid }))
      .not.toBe(formatRunWorkspaceHash(run.run_id, { kind: "artifact", artifact_id: artifactId }));
  });

  it("replacing the route target leaves one selected pane", () => {
    const sessionRoute = formatRunWorkspaceHash(run.run_id, { kind: "session", session_id: session.sid as Sid });
    const artifactRoute = formatRunWorkspaceHash(run.run_id, { kind: "artifact", artifact_id: revision.id as ArtifactId });
    expect(readHashRoute(`#${artifactRoute}`)).toMatchObject({ route: { pane: { kind: "artifact", artifact_id: revision.id } } });
    expect(sessionRoute).not.toBe(artifactRoute);
  });

  it("the overview route carries no entity target", () => {
    expect(readHashRoute(`#${formatRunWorkspaceHash(run.run_id, null)}`)).toMatchObject({ route: { pane: null } });
  });
});
