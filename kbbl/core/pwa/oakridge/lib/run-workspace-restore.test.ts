import { describe, expect, it } from "vitest";

import type { Sid } from "../../lib/ids";
import { formatRunWorkspaceHash, readHashRoute } from "../../lib/hash";
import {
  makeBuildBriefFixture, makeBuildResultFixture, makeRunView, makeRunUnitSummary, makeUnitView, makeUnitWithArtifact,
  makeSessionSnapshot,
} from "../__fixtures__/read-models";
import {
  selectArtifactInUnits, selectLoadedUnits, selectRunArtifacts, selectRunUnit, selectUnitDetail,
} from "./run-overview";

describe("generated workspace route resolution", () => {
  const brief = makeBuildBriefFixture();
  const result = makeBuildResultFixture();
  const units = [
    makeUnitWithArtifact({ body: brief.body, artifact_key: "brief", revision_id: "brief-revision",
      unit: { unit_id: "brief-unit" } }),
    makeUnitWithArtifact({ body: result.body, artifact_key: "build_result", revision_id: "result-revision",
      unit: { unit_id: "build-unit" } }),
  ];

  it("indexes the current artifact revisions from all loaded units", () => {
    expect(selectRunArtifacts(units).map((entry) => entry.revision.id)).toEqual(["brief-revision", "result-revision"]);
  });

  it("does not resolve an artifact revision absent from current unit projections", () => {
    expect(selectArtifactInUnits(units, "deleted-revision")).toBeNull();
    expect(selectArtifactInUnits(units, "result-revision")?.unit_id).toBe("build-unit");
  });

  it("uses an explicit unit route before the root fallback", () => {
    const run = makeRunView({ units: [
      makeRunUnitSummary({ unit_id: "root", unit_key: "development" }),
      makeRunUnitSummary({ unit_id: "build", unit_key: "build" }),
    ] });
    expect(selectRunUnit(run, "build", "development")?.unit_id).toBe("build");
    expect(selectRunUnit(run, "missing", "development")?.unit_id).toBe("root");
  });

  it("does not display a deleted unit detail from a stale route ID", () => {
    expect(selectUnitDetail(units, "deleted-unit")).toBeNull();
    expect(selectUnitDetail(units, "brief-unit")?.unit_id).toBe("brief-unit");
  });

  it("keeps successfully loaded units when another unit read is unavailable", () => {
    expect(selectLoadedUnits([units[0], undefined, units[1]])).toEqual(units);
    expect(selectLoadedUnits([undefined])).toEqual([]);
  });

  it("retains an explicit session route without a separate attempt-list read", () => {
    const sid = makeSessionSnapshot("sid-prior").sid as Sid;
    const route = formatRunWorkspaceHash(makeRunView().run_id, { kind: "session", session_id: sid });
    expect(readHashRoute(`#${route}`)).toMatchObject({ route: { pane: { kind: "session", session_id: "sid-prior" } } });
  });

  it("defaults to the first generated unit only when no unit route was supplied", () => {
    expect(selectUnitDetail([makeUnitView({ unit_id: "root" })], null)?.unit_id).toBe("root");
  });
});
