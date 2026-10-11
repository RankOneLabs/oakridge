import { describe, expect, it } from "vitest";

import type { Sid } from "../../lib/ids";
import { formatRunWorkspaceHash, readHashRoute } from "../../lib/hash";
import {
  makeBuildBriefFixture, makeBuildResultFixture, makeRunDetail, makeRunScopeSummary, makeScopeView, makeScopeWithOutput,
  makeSessionSnapshot,
} from "../__fixtures__/read-models";
import {
  selectArtifactInScopes, selectLoadedScopes, selectRunArtifacts, selectRunScope, selectScopeDetail,
} from "./run-overview";

describe("generated workspace route resolution", () => {
  const brief = makeBuildBriefFixture();
  const result = makeBuildResultFixture();
  const scopes = [
    makeScopeWithOutput({ body: brief.body, output_key: "brief", revision_id: "brief-revision",
      scope: { scope_id: "brief-scope" } }),
    makeScopeWithOutput({ body: result.body, output_key: "build_result", revision_id: "result-revision",
      scope: { scope_id: "build-scope" } }),
  ];

  it("indexes the current artifact revisions from all loaded scopes", () => {
    expect(selectRunArtifacts(scopes).map((entry) => entry.revision.id)).toEqual(["brief-revision", "result-revision"]);
  });

  it("does not resolve an artifact revision absent from current scope projections", () => {
    expect(selectArtifactInScopes(scopes, "deleted-revision")).toBeNull();
    expect(selectArtifactInScopes(scopes, "result-revision")?.scope_id).toBe("build-scope");
  });

  it("uses an explicit scope route before the root fallback", () => {
    const run = makeRunDetail({ scopes: [
      makeRunScopeSummary({ scope_id: "root", scope_key: "development" }),
      makeRunScopeSummary({ scope_id: "build", scope_key: "build" }),
    ] });
    expect(selectRunScope(run, "build", "development")?.scope_id).toBe("build");
    expect(selectRunScope(run, "missing", "development")?.scope_id).toBe("root");
  });

  it("does not display a deleted scope detail from a stale route ID", () => {
    expect(selectScopeDetail(scopes, "deleted-scope")).toBeNull();
    expect(selectScopeDetail(scopes, "brief-scope")?.scope_id).toBe("brief-scope");
  });

  it("keeps successfully loaded scopes when another scope read is unavailable", () => {
    expect(selectLoadedScopes([scopes[0], undefined, scopes[1]])).toEqual(scopes);
    expect(selectLoadedScopes([undefined])).toEqual([]);
  });

  it("retains an explicit session route without a separate attempt-list read", () => {
    const sid = makeSessionSnapshot("sid-prior").sid as Sid;
    const route = formatRunWorkspaceHash(makeRunDetail().run_id, { kind: "session", session_id: sid });
    expect(readHashRoute(`#${route}`)).toMatchObject({ route: { pane: { kind: "session", session_id: "sid-prior" } } });
  });

  it("defaults to the first generated scope only when no scope route was supplied", () => {
    expect(selectScopeDetail([makeScopeView({ scope_id: "root" })], null)?.scope_id).toBe("root");
  });
});
