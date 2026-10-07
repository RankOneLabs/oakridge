import { describe, expect, test } from "vitest";
import type { ArtifactDetail, RunDetail } from "../types";
import {
  parseBuildResult,
  selectCohortBriefArtifactId,
  selectCohortBriefLookup,
  selectFileScopeComparison,
  selectOrderedIssues,
  selectTestEvidenceText,
  type CohortBriefSources,
} from "./build-result";

const body = {
  repository_key: "assay",
  summary: "Built the API.",
  changed_files: ["src/api.py"],
  tests: { passed: 78, failed: 0, output: "78 passed" },
  delegated_session_metadata: { cohort_id: "cm-api" },
  known_issues: [{ severity: "info", description: "Slow fixture." }],
};

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

describe("parseBuildResult", () => {
  test("reads omitted test text and metadata fields as null", () => {
    const result = parseBuildResult(body);
    expect(result.ok && [result.value.tests.summary, result.value.delegated_session_metadata?.branch]).toEqual([null, null]);
  });

  test("names an issue whose severity is outside the contract", () => {
    const result = parseBuildResult({ ...body, known_issues: [{ severity: "critical", description: "x" }] });
    expect(result.ok ? null : result.error.field).toBe("known_issues[0]");
  });

  test("rejects test evidence without counts", () => {
    expect(parseBuildResult({ ...body, tests: { output: "ran" } }).ok).toBe(false);
  });
});

describe("selectFileScopeComparison", () => {
  const comparison = selectFileScopeComparison(["src/api.py", "src/errors.py", "docs/"], ["src/api.py", "docs/guide.md", "ci.yml"]);

  test("counts a file under a planned directory as in scope", () => {
    expect(comparison.changed_in_scope).toEqual(["src/api.py", "docs/guide.md"]);
  });

  test("flags a changed file the brief never named", () => {
    expect(comparison.changed_out_of_scope).toEqual(["ci.yml"]);
  });

  test("lists planned files the build left alone", () => {
    expect(comparison.planned_untouched).toEqual(["src/errors.py"]);
  });
});

describe("selectCohortBriefArtifactId", () => {
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

  test("picks the latest brief for the cohort", () => {
    expect(selectCohortBriefArtifactId(run, "cm-api")).toBe("brief-new");
  });

  test("finds nothing for a cohort without a brief", () => {
    expect(selectCohortBriefArtifactId(run, "cm-ui")).toBeNull();
  });
});

describe("selectCohortBriefLookup", () => {
  const sources: CohortBriefSources = {
    cohort_label: "cm-api",
    run: {} as RunDetail,
    is_run_pending: false,
    brief_artifact_id: "brief-new",
    brief_detail: { revisions: [{ body: { goal: "stale" } }, { body: brief }] } as unknown as ArtifactDetail,
    is_brief_pending: false,
  };

  test("reads the brief's latest revision", () => {
    const lookup = selectCohortBriefLookup(sources);
    expect(lookup.kind === "found" && lookup.brief.title).toBe("Assemble the API");
  });

  test("waits while the brief loads", () => {
    expect(selectCohortBriefLookup({ ...sources, brief_detail: undefined, is_brief_pending: true }).kind).toBe("loading");
  });

  test("reports the brief missing when the run has none", () => {
    expect(selectCohortBriefLookup({ ...sources, brief_artifact_id: null }).kind).toBe("missing");
  });

  test("reports the brief missing when its body breaks the contract", () => {
    expect(selectCohortBriefLookup({ ...sources, brief_detail: { revisions: [{ body: { goal: "x" } }] } as unknown as ArtifactDetail }).kind).toBe("missing");
  });
});

describe("issue and evidence selectors", () => {
  test("orders issues blocking first", () => {
    const ordered = selectOrderedIssues([
      { severity: "info", description: "a" },
      { severity: "blocking", description: "b" },
      { severity: "warning", description: "c" },
    ]);
    expect(ordered.map((issue) => issue.description)).toEqual(["b", "c", "a"]);
  });

  test("skips blank evidence text", () => {
    expect(selectTestEvidenceText({ passed: 1, failed: 0, output: "ok", summary: " ", cargo_test_output: null })).toEqual(["ok"]);
  });
});
