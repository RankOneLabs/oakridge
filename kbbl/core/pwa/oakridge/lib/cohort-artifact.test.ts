import { describe, expect, test } from "vitest";
import type { ArtifactDetail, RunDetail } from "../types";
import { readBuildBrief, type BuildBrief } from "./build-brief";
import { selectCohortArtifactId, selectCohortArtifactLookup, type CohortArtifactLookup, type CohortArtifactSources } from "./cohort-artifact";

const brief = {
  cohort_id: "cm-api",
  repository_key: "assay",
  title: "Assemble the API",
  depends_on: [],
  goal: "Build analyze().",
  files_in_scope: ["src/api.py"],
  decisions_made: [],
  approaches_rejected: [],
  acceptance_criteria: ["It works."],
  next_action: "Start.",
};

describe("selectCohortArtifactId", () => {
  const run = {
    stages: [
      { artifacts: [{ id: "brief-old", type_id: "dev.build_brief", version: 1, label: "cm-api" }] },
      { artifacts: [
        { id: "brief-new", type_id: "dev.build_brief", version: 2, label: "cm-api" },
        { id: "other", type_id: "dev.build_brief", version: 3, label: "cm-cli" },
        { id: "result", type_id: "dev.build_result", version: 4, label: "cm-api" },
      ] },
    ],
  } as unknown as RunDetail;

  test("picks the latest artifact of the type for the cohort", () => {
    expect(selectCohortArtifactId(run, "dev.build_brief", "cm-api")).toBe("brief-new");
  });

  test("tells types apart under the same cohort label", () => {
    expect(selectCohortArtifactId(run, "dev.build_result", "cm-api")).toBe("result");
  });

  test("finds nothing for a cohort without one", () => {
    expect(selectCohortArtifactId(run, "dev.build_brief", "cm-ui")).toBeNull();
  });
});

describe("selectCohortArtifactLookup", () => {
  const revisions = [
    { created_at: "2026-10-01T10:00:00Z", body: { ...brief, title: "First draft" } },
    { created_at: "2026-10-02T10:00:00Z", body: brief },
    { created_at: "2026-10-03T10:00:00Z", body: { ...brief, title: "Revised after the build" } },
  ];
  const settled = <T>(data: T) => ({ data, is_loading: false, is_error: false });
  const sources: CohortArtifactSources = {
    cohort_label: "cm-api",
    as_of: "2026-10-02T12:00:00Z",
    run: settled({} as RunDetail),
    artifact_id: "brief-new",
    detail: settled({ revisions } as unknown as ArtifactDetail),
  };
  const title = (lookup: CohortArtifactLookup<BuildBrief>) => (lookup.kind === "found" ? lookup.value.title : lookup.kind);

  test("reads the revision that stood when the viewed revision was written", () => {
    expect(title(selectCohortArtifactLookup(sources, readBuildBrief))).toBe("Assemble the API");
  });

  test("reads the latest revision when viewing the newest", () => {
    expect(title(selectCohortArtifactLookup({ ...sources, as_of: "2026-10-04T00:00:00Z" }, readBuildBrief))).toBe("Revised after the build");
  });

  test("reports it missing when it had no revision yet", () => {
    expect(selectCohortArtifactLookup({ ...sources, as_of: "2026-09-30T00:00:00Z" }, readBuildBrief).kind).toBe("missing");
  });

  test("waits while the artifact loads", () => {
    const loading = { data: undefined, is_loading: true, is_error: false };
    expect(selectCohortArtifactLookup({ ...sources, detail: loading }, readBuildBrief).kind).toBe("loading");
  });

  test("reports a failed artifact request as an error, not as missing", () => {
    const failed = { data: undefined, is_loading: false, is_error: true };
    expect(selectCohortArtifactLookup({ ...sources, detail: failed }, readBuildBrief).kind).toBe("error");
  });

  test("reports a failed run request as an error", () => {
    const failed = { data: undefined, is_loading: false, is_error: true };
    expect(selectCohortArtifactLookup({ ...sources, run: failed }, readBuildBrief).kind).toBe("error");
  });

  test("keeps data it already has when a refetch fails", () => {
    const stale = { ...sources.detail, is_error: true };
    expect(selectCohortArtifactLookup({ ...sources, detail: stale }, readBuildBrief).kind).toBe("found");
  });

  test("reports it missing when the run has none", () => {
    expect(selectCohortArtifactLookup({ ...sources, artifact_id: null }, readBuildBrief).kind).toBe("missing");
  });

  test("reports it missing when its body breaks the contract", () => {
    const broken = settled({ revisions: [{ created_at: "2026-10-01T00:00:00Z", body: { goal: "x" } }] } as unknown as ArtifactDetail);
    expect(selectCohortArtifactLookup({ ...sources, detail: broken }, readBuildBrief).kind).toBe("missing");
  });

  test("reports it missing when there is no cohort to look under", () => {
    expect(selectCohortArtifactLookup({ ...sources, cohort_label: null }, readBuildBrief).kind).toBe("missing");
  });
});
