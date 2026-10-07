import { describe, expect, test } from "vitest";
import type { ArtifactDetail, RunDetail } from "../types";
import { readBuildBrief } from "./build-brief";
import { selectCohortArtifactId, selectCohortArtifactLookup, type CohortArtifactSources } from "./cohort-artifact";

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
  const sources: CohortArtifactSources = {
    cohort_label: "cm-api",
    run: {} as RunDetail,
    is_run_loading: false,
    artifact_id: "brief-new",
    detail: { revisions: [{ body: { goal: "stale" } }, { body: brief }] } as unknown as ArtifactDetail,
    is_detail_loading: false,
  };

  test("reads the latest revision", () => {
    const lookup = selectCohortArtifactLookup(sources, readBuildBrief);
    expect(lookup.kind === "found" && lookup.value.title).toBe("Assemble the API");
  });

  test("waits while the artifact loads", () => {
    expect(selectCohortArtifactLookup({ ...sources, detail: undefined, is_detail_loading: true }, readBuildBrief).kind).toBe("loading");
  });

  test("reports it missing when the run has none", () => {
    expect(selectCohortArtifactLookup({ ...sources, artifact_id: null }, readBuildBrief).kind).toBe("missing");
  });

  test("reports it missing when its body breaks the contract", () => {
    const broken = { revisions: [{ body: { goal: "x" } }] } as unknown as ArtifactDetail;
    expect(selectCohortArtifactLookup({ ...sources, detail: broken }, readBuildBrief).kind).toBe("missing");
  });

  test("reports it missing when there is no cohort to look under", () => {
    expect(selectCohortArtifactLookup({ ...sources, cohort_label: null }, readBuildBrief).kind).toBe("missing");
  });
});
