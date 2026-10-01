import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import { RunOverviewPane } from "../components/organisms/RunOverviewPane";
import type { RunDiagnosis } from "../types";

const overview: RunDiagnosis = {
  run: { id: "run-1", title: null, repository_keys: [], workflow_name: "test", status: "active", blocked_reason: null, next_actor: "core", stages: [], parked_count: 0, updated_at: "2026-09-29T00:00:00Z" },
  sessions: [], current_session: null, sessions_awaiting_action: [], active_gates: [], pull_request_merge_waits: [], recent_artifacts: [],
  stage_progress: { total: 0, pending: 0, active: 0, blocked: 0, complete: 0, failed: 0, cancelled: 0 },
};

describe("RunOverviewPane", () => {
  it("links pull request activity to the pull request", () => {
    render(<RunOverviewPane overview={overview} onOpenPane={() => {}} activity={{ kind: "loaded", items: [{
      sequence: "1", operation: "pull_request_observed", occurred_at: "2026-09-29T00:00:00Z",
      summary: "Pull request observed", context: "build · web", is_optional_attention: false,
      pull_request_url: "https://github.com/RankOneLabs/oakridge/pull/528",
    }] }} />);

    expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href"))
      .toBe("https://github.com/RankOneLabs/oakridge/pull/528");
  });
});
