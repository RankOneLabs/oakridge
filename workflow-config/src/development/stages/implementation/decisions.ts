import type { DecisionTree } from "../../../source-contracts";
import { literal, reference, variant } from "../../../primitives/expressions";
import { github_auth_failure, begin_build, build_pair_complete, build_open_pr, feedback_open_pr, retry_retained_exact } from "./build";
import { assessment_submission_context, assessment_accept_context, discussion_context, unchanged_context, implementation_feedback_context, retry_assessment_context } from "./assessment";
import { replace_closed_pr, merge_context, refresh_pr, matching_pr_observation } from "./pull-request";

const implementation_cancel: DecisionTree = {
  kind: "apply",
  id: "implementation_cancel",
  mutations: [
    { kind: "revoke", worker: "build" },
    { kind: "stop", worker: "build" },
    { kind: "revoke", worker: "assessment" },
    { kind: "stop", worker: "assessment" },
    { kind: "release", pool: "implementation_slots" },
    { kind: "export", key: "accepted", value: literal("flag", false) },
    { kind: "revoke", worker: "pr_observer" },
    { kind: "stop", worker: "pr_observer" }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "cancelled", value: literal("unit", {}) })
};

const implementation_abandon: DecisionTree = {
  kind: "apply",
  id: "implementation_abandon",
  mutations: [
    { kind: "revoke", worker: "build" },
    { kind: "stop", worker: "build" },
    { kind: "revoke", worker: "assessment" },
    { kind: "stop", worker: "assessment" },
    { kind: "release", pool: "implementation_slots" },
    { kind: "export", key: "accepted", value: literal("flag", false) },
    { kind: "revoke", worker: "pr_observer" },
    { kind: "stop", worker: "pr_observer" }
  ],
  actions: [],
  outcome: variant({ schema: "result", variant: "failed", value: literal("unit", {}) })
};

const implementation_wait: DecisionTree = {
  kind: "wait",
  id: "implementation_wait",
  continuations: ["accept_build"],
  reason: "awaiting declared work or operator review",
  attention: { label: "Awaiting work or review", trigger: "accept_build" }
};

export const implementation_dispatch: DecisionTree = {
  kind: "match",
  id: "implementation_dispatch",
  value: reference({ kind: "trigger" }, []),
  cases: [
    { variant: "auth", node: github_auth_failure },
    { variant: "begin", node: begin_build },
    { variant: "build_submitted", node: build_pair_complete },
    { variant: "accept_build", node: build_open_pr },
    { variant: "request_build_changes", node: feedback_open_pr },
    { variant: "retry_build", node: retry_retained_exact },
    { variant: "assessment_submitted", node: assessment_submission_context },
    { variant: "accept_assessment", node: assessment_accept_context },
    { variant: "discuss_assessment", node: discussion_context },
    { variant: "assessment_unchanged", node: unchanged_context },
    { variant: "request_implementation_changes", node: implementation_feedback_context },
    { variant: "retry_assessment", node: retry_assessment_context },
    { variant: "replace_pr", node: replace_closed_pr },
    { variant: "confirm_merged", node: merge_context },
    { variant: "cancel", node: implementation_cancel },
    { variant: "abandon", node: implementation_abandon },
    { variant: "session_failed", node: { ...implementation_abandon, id: "implementation_session_failed" } },
    { variant: "refresh_pr", node: refresh_pr },
    { variant: "pr_observed", node: matching_pr_observation }
  ],
  otherwise: implementation_wait
};
