use serde::Deserialize;
use serde_json::Value;

use crate::registry::artifact_type::{ArtifactCapabilities, ArtifactTypeDef, ArtifactTypeRegistry};

// ── Body structs for schema validation ───────────────────────────────────────
//
// Validators follow the registry convention:
//   serde_json::from_value::<Body>(v.clone()).map(|_| ()).map_err(Into::into)
//
// Required fields must be present; `Option<T>` fields are optional.
// Array element types use `Value` to allow any JSON object per the brief.

#[derive(Deserialize)]
struct SpecAnalysisBody {
    summary: String,
    source_spec_refs: Vec<Value>,
    findings: Vec<Value>,
    requirements: Vec<Value>,
    risks: Vec<Value>,
}

fn validate_spec_analysis(v: &Value) -> crate::Result<()> {
    serde_json::from_value::<SpecAnalysisBody>(v.clone())
        .map(|_| ())
        .map_err(Into::into)
}

#[derive(Deserialize)]
struct PlanBody {
    summary: String,
    cohorts: Vec<Value>,
    dependency_order: Vec<Value>,
    scope: Value,
    acceptance_criteria: Vec<Value>,
    risks: Vec<Value>,
}

fn validate_plan(v: &Value) -> crate::Result<()> {
    serde_json::from_value::<PlanBody>(v.clone())
        .map(|_| ())
        .map_err(Into::into)
}

#[derive(Deserialize)]
struct BuildResultBody {
    summary: String,
    changed_files: Vec<String>,
    tests: Value,
    delegated_session_metadata: Option<Value>,
    known_issues: Vec<Value>,
}

fn validate_build_result(v: &Value) -> crate::Result<()> {
    serde_json::from_value::<BuildResultBody>(v.clone())
        .map(|_| ())
        .map_err(Into::into)
}

#[derive(Deserialize)]
struct AssessmentBody {
    verdict: String,
    findings: Vec<Value>,
    test_evidence: Option<Value>,
    recommended_next_actions: Vec<Value>,
}

fn validate_assessment(v: &Value) -> crate::Result<()> {
    serde_json::from_value::<AssessmentBody>(v.clone())
        .map(|_| ())
        .map_err(Into::into)
}

#[derive(Deserialize)]
struct PrSummaryBody {
    pr_url: String,
    branch: String,
    summary: String,
    review_status: Option<String>,
}

fn validate_pr_summary(v: &Value) -> crate::Result<()> {
    serde_json::from_value::<PrSummaryBody>(v.clone())
        .map(|_| ())
        .map_err(Into::into)
}

// ── Registration ──────────────────────────────────────────────────────────────

/// Register the five dev-flow artifact types in the given registry.
///
/// Types registered:
/// - `dev.spec_analysis`  — spec-analysis output: summary, findings, requirements, risks.
/// - `dev.plan`           — implementation plan: cohorts, scope, acceptance criteria.
/// - `dev.build_result`   — build output: changed files, tests, known issues.
/// - `dev.assessment`     — post-build assessment: verdict, findings, next actions.
/// - `dev.pr_summary`     — PR metadata: url, branch, summary, review status.
///
/// `dev.pr_summary` is registered but not required by the first workflow graph;
/// it becomes a gate artifact once PR ownership is decided.
pub fn register_dev_flow_types(registry: &mut ArtifactTypeRegistry) {
    // dev.spec_analysis: reviewable, commentable, review_items; no atom editing.
    registry.register(ArtifactTypeDef {
        id: "dev.spec_analysis".into(),
        validate: validate_spec_analysis,
        component_id: "dev-spec-analysis-viewer".into(),
        capabilities: ArtifactCapabilities {
            reviewable: true,
            commentable: true,
            atom_editable: false,
            review_items: true,
        },
        anchor_schema: None,
    });
    // dev.plan: fully interactive (cohort 5); anchor_schema covers cohort/dependency atoms.
    registry.register(ArtifactTypeDef {
        id: "dev.plan".into(),
        validate: validate_plan,
        component_id: "dev-plan-viewer".into(),
        capabilities: ArtifactCapabilities {
            reviewable: true,
            commentable: true,
            atom_editable: true,
            review_items: false,
        },
        anchor_schema: Some(vec![
            "/cohorts".into(),
            "/dependency_order".into(),
        ]),
    });
    // dev.build_result: reviewable, commentable, atom_editable; anchor_schema covers top-level sections.
    registry.register(ArtifactTypeDef {
        id: "dev.build_result".into(),
        validate: validate_build_result,
        component_id: "dev-build-result-viewer".into(),
        capabilities: ArtifactCapabilities {
            reviewable: true,
            commentable: true,
            atom_editable: true,
            review_items: false,
        },
        anchor_schema: Some(vec![
            "/summary".into(),
            "/changed_files".into(),
            "/tests".into(),
            "/known_issues".into(),
        ]),
    });
    // dev.assessment: reviewable, commentable; no atom editing or review_items.
    registry.register(ArtifactTypeDef {
        id: "dev.assessment".into(),
        validate: validate_assessment,
        component_id: "dev-assessment-viewer".into(),
        capabilities: ArtifactCapabilities {
            reviewable: true,
            commentable: true,
            atom_editable: false,
            review_items: false,
        },
        anchor_schema: None,
    });
    // dev.pr_summary: reviewable only.
    registry.register(ArtifactTypeDef {
        id: "dev.pr_summary".into(),
        validate: validate_pr_summary,
        component_id: "dev-pr-summary-viewer".into(),
        capabilities: ArtifactCapabilities {
            reviewable: true,
            commentable: false,
            atom_editable: false,
            review_items: false,
        },
        anchor_schema: None,
    });
}

// ── Tests ─────────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_registry() -> ArtifactTypeRegistry {
        let mut reg = ArtifactTypeRegistry::new();
        register_dev_flow_types(&mut reg);
        reg
    }

    // ── Registration ─────────────────────────────────────────────────────────

    #[test]
    fn all_five_dev_flow_types_registered() {
        let reg = make_registry();
        assert!(reg.get("dev.spec_analysis").is_some());
        assert!(reg.get("dev.plan").is_some());
        assert!(reg.get("dev.build_result").is_some());
        assert!(reg.get("dev.assessment").is_some());
        assert!(reg.get("dev.pr_summary").is_some());
    }

    #[test]
    fn unknown_dev_flow_type_not_registered() {
        let reg = make_registry();
        assert!(reg.get("dev.unknown").is_none());
        assert!(reg.get("dev.").is_none());
        assert!(reg.get("spec_analysis").is_none());
    }

    // ── dev.spec_analysis ────────────────────────────────────────────────────

    #[test]
    fn spec_analysis_valid_body_passes() {
        let reg = make_registry();
        let def = reg.get("dev.spec_analysis").unwrap();
        let body = json!({
            "summary": "Codebase matches spec.",
            "source_spec_refs": ["section 1", "section 2"],
            "findings": [{"id": "f1", "description": "match", "severity": "info"}],
            "requirements": [{"id": "r1", "description": "must do X", "status": "implementable"}],
            "risks": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn spec_analysis_empty_arrays_pass() {
        let reg = make_registry();
        let def = reg.get("dev.spec_analysis").unwrap();
        let body = json!({
            "summary": "No issues.",
            "source_spec_refs": [],
            "findings": [],
            "requirements": [],
            "risks": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn spec_analysis_missing_summary_fails() {
        let reg = make_registry();
        let def = reg.get("dev.spec_analysis").unwrap();
        let body = json!({
            "source_spec_refs": [],
            "findings": [],
            "requirements": [],
            "risks": []
        });
        assert!((def.validate)(&body).is_err());
    }

    #[test]
    fn spec_analysis_missing_findings_fails() {
        let reg = make_registry();
        let def = reg.get("dev.spec_analysis").unwrap();
        let body = json!({
            "summary": "ok",
            "source_spec_refs": [],
            "requirements": [],
            "risks": []
        });
        assert!((def.validate)(&body).is_err());
    }

    // ── dev.plan ─────────────────────────────────────────────────────────────

    #[test]
    fn plan_valid_body_passes() {
        let reg = make_registry();
        let def = reg.get("dev.plan").unwrap();
        let body = json!({
            "summary": "Plan for adding feature X.",
            "cohorts": [{"id": "c1", "title": "Cohort 1"}],
            "dependency_order": ["c1"],
            "scope": {"files": ["src/lib.rs"]},
            "acceptance_criteria": ["Tests pass", "Typecheck clean"],
            "risks": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn plan_missing_cohorts_fails() {
        let reg = make_registry();
        let def = reg.get("dev.plan").unwrap();
        let body = json!({
            "summary": "Plan",
            "dependency_order": [],
            "scope": {},
            "acceptance_criteria": [],
            "risks": []
        });
        assert!((def.validate)(&body).is_err());
    }

    #[test]
    fn plan_missing_scope_fails() {
        let reg = make_registry();
        let def = reg.get("dev.plan").unwrap();
        let body = json!({
            "summary": "Plan",
            "cohorts": [],
            "dependency_order": [],
            "acceptance_criteria": [],
            "risks": []
        });
        assert!((def.validate)(&body).is_err());
    }

    // ── dev.build_result ─────────────────────────────────────────────────────

    #[test]
    fn build_result_valid_body_passes() {
        let reg = make_registry();
        let def = reg.get("dev.build_result").unwrap();
        let body = json!({
            "summary": "Build complete.",
            "changed_files": ["src/lib.rs", "tests/foo.rs"],
            "tests": {"passed": 42, "failed": 0},
            "known_issues": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn build_result_with_optional_delegated_metadata_passes() {
        let reg = make_registry();
        let def = reg.get("dev.build_result").unwrap();
        let body = json!({
            "summary": "Build complete.",
            "changed_files": [],
            "tests": {},
            "delegated_session_metadata": {
                "session_id": "sid-abc",
                "branch": "cohort/v2/1-foo"
            },
            "known_issues": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn build_result_missing_changed_files_fails() {
        let reg = make_registry();
        let def = reg.get("dev.build_result").unwrap();
        let body = json!({
            "summary": "Build complete.",
            "tests": {},
            "known_issues": []
        });
        assert!((def.validate)(&body).is_err());
    }

    // ── dev.assessment ───────────────────────────────────────────────────────

    #[test]
    fn assessment_valid_body_passes() {
        let reg = make_registry();
        let def = reg.get("dev.assessment").unwrap();
        let body = json!({
            "verdict": "pass",
            "findings": [{"description": "All tests pass"}],
            "recommended_next_actions": ["Ship it"]
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn assessment_with_optional_test_evidence_passes() {
        let reg = make_registry();
        let def = reg.get("dev.assessment").unwrap();
        let body = json!({
            "verdict": "pass_with_notes",
            "findings": [],
            "test_evidence": {"cargo_test_output": "test result: ok"},
            "recommended_next_actions": []
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn assessment_missing_verdict_fails() {
        let reg = make_registry();
        let def = reg.get("dev.assessment").unwrap();
        let body = json!({
            "findings": [],
            "recommended_next_actions": []
        });
        assert!((def.validate)(&body).is_err());
    }

    // ── dev.pr_summary ───────────────────────────────────────────────────────

    #[test]
    fn pr_summary_valid_body_passes() {
        let reg = make_registry();
        let def = reg.get("dev.pr_summary").unwrap();
        let body = json!({
            "pr_url": "https://github.com/owner/repo/pull/42",
            "branch": "cohort/v2/1-foo",
            "summary": "Adds dev-flow artifact types."
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn pr_summary_with_review_status_passes() {
        let reg = make_registry();
        let def = reg.get("dev.pr_summary").unwrap();
        let body = json!({
            "pr_url": "https://github.com/owner/repo/pull/42",
            "branch": "cohort/v2/1-foo",
            "summary": "Adds dev-flow artifact types.",
            "review_status": "approved"
        });
        assert!((def.validate)(&body).is_ok());
    }

    #[test]
    fn pr_summary_missing_pr_url_fails() {
        let reg = make_registry();
        let def = reg.get("dev.pr_summary").unwrap();
        let body = json!({
            "branch": "cohort/v2/1-foo",
            "summary": "Adds dev-flow artifact types."
        });
        assert!((def.validate)(&body).is_err());
    }

    #[test]
    fn pr_summary_missing_branch_fails() {
        let reg = make_registry();
        let def = reg.get("dev.pr_summary").unwrap();
        let body = json!({
            "pr_url": "https://github.com/owner/repo/pull/42",
            "summary": "Adds dev-flow artifact types."
        });
        assert!((def.validate)(&body).is_err());
    }
}
