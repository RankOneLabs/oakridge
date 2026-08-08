use chrono::{DateTime, Utc};
use serde::{Deserialize, Serialize};

use crate::types::{ForgeProvider, ForgeRepositoryIdentity, StageInstanceId, WorkflowRunId};

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestObservationSource {
    Poll,
    Webhook,
    ManualRecheck,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum ObservedPullRequestState {
    Open,
    Merged,
    ClosedUnmerged,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PullRequestObservation {
    pub provider: ForgeProvider,
    pub owner: String,
    pub name: String,
    pub number: u64,
    pub url: String,
    pub head_branch: String,
    pub base_branch: String,
    pub head_sha: Option<String>,
    pub state: ObservedPullRequestState,
    pub source: PullRequestObservationSource,
    pub observed_at: DateTime<Utc>,
    pub merged_at: Option<DateTime<Utc>>,
}

#[derive(Serialize, Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum PullRequestMismatchKind {
    MissingRepositoryIdentity,
    RepositoryMismatch,
    PullRequestMismatch,
    HeadBranchMismatch,
    BaseBranchMismatch,
    ClosedWithoutMerge,
    StaleObservation,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct PullRequestMismatch {
    pub kind: PullRequestMismatchKind,
    pub detail: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ExpectedCohortPullRequest {
    pub workflow_run_id: WorkflowRunId,
    pub stage_instance_id: StageInstanceId,
    pub unit_id: String,
    pub repository_key: String,
    pub repository: ForgeRepositoryIdentity,
    pub number: u64,
    pub url: String,
    pub head_branch: String,
    pub base_branch: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Eq)]
pub struct CohortPullRequestReconciliation {
    pub workflow_run_id: WorkflowRunId,
    pub stage_instance_id: StageInstanceId,
    pub unit_id: String,
    pub repository_key: String,
    pub observation: PullRequestObservation,
    pub mismatch: Option<PullRequestMismatch>,
    pub completed_at: Option<DateTime<Utc>>,
    pub updated_at: DateTime<Utc>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReconciliationDecision {
    Waiting,
    Complete,
    Mismatch(PullRequestMismatch),
    IgnoreStale(PullRequestMismatch),
}

pub fn github_pull_request_identity(url: &str) -> Option<(String, String, u64)> {
    let path = url
        .strip_prefix("https://github.com/")?
        .trim_end_matches('/');
    let mut segments = path.split('/');
    let owner = segments.next()?.to_owned();
    let name = segments.next()?.to_owned();
    if segments.next()? != "pull" {
        return None;
    }
    let number = segments.next()?.parse().ok()?;
    if owner.is_empty() || name.is_empty() || number == 0 || segments.next().is_some() {
        return None;
    }
    Some((owner, name, number))
}

pub fn github_repository_identity_matches(
    left_owner: &str,
    left_name: &str,
    right_owner: &str,
    right_name: &str,
) -> bool {
    left_owner.eq_ignore_ascii_case(right_owner) && left_name.eq_ignore_ascii_case(right_name)
}

fn github_pull_request_urls_match(left: &str, right: &str) -> bool {
    match (
        github_pull_request_identity(left),
        github_pull_request_identity(right),
    ) {
        (Some((left_owner, left_name, left_number)), Some((right_owner, right_name, right_number))) => {
            left_number == right_number
                && github_repository_identity_matches(
                    &left_owner,
                    &left_name,
                    &right_owner,
                    &right_name,
                )
        }
        _ => false,
    }
}

pub fn reconcile_pull_request(
    expected: &ExpectedCohortPullRequest,
    observation: &PullRequestObservation,
    previous: Option<&CohortPullRequestReconciliation>,
) -> ReconciliationDecision {
    if previous.is_some_and(|record| record.observation.observed_at > observation.observed_at) {
        return ReconciliationDecision::IgnoreStale(PullRequestMismatch {
            kind: PullRequestMismatchKind::StaleObservation,
            detail: "observation is older than the durable reconciliation state".into(),
        });
    }
    if observation.provider != expected.repository.provider
        || !github_repository_identity_matches(
            &observation.owner,
            &observation.name,
            &expected.repository.owner,
            &expected.repository.name,
        )
    {
        return mismatch(
            PullRequestMismatchKind::RepositoryMismatch,
            "observed pull request belongs to another repository",
        );
    }
    if observation.number != expected.number
        || !github_pull_request_urls_match(&observation.url, &expected.url)
    {
        return mismatch(
            PullRequestMismatchKind::PullRequestMismatch,
            "observed pull request does not match the build's durable PR identity",
        );
    }
    if observation.head_branch != expected.head_branch {
        return mismatch(
            PullRequestMismatchKind::HeadBranchMismatch,
            "observed pull request head branch does not match the cohort branch",
        );
    }
    if observation.base_branch != expected.base_branch {
        return mismatch(
            PullRequestMismatchKind::BaseBranchMismatch,
            "observed pull request base branch is not the repository epic branch",
        );
    }
    match observation.state {
        ObservedPullRequestState::Open => ReconciliationDecision::Waiting,
        ObservedPullRequestState::Merged if observation.merged_at.is_some() => {
            ReconciliationDecision::Complete
        }
        ObservedPullRequestState::Merged => mismatch(
            PullRequestMismatchKind::PullRequestMismatch,
            "merged observation is missing merged_at evidence",
        ),
        ObservedPullRequestState::ClosedUnmerged => mismatch(
            PullRequestMismatchKind::ClosedWithoutMerge,
            "pull request closed without merging into the epic branch",
        ),
    }
}

fn mismatch(kind: PullRequestMismatchKind, detail: &str) -> ReconciliationDecision {
    ReconciliationDecision::Mismatch(PullRequestMismatch {
        kind,
        detail: detail.into(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::TimeZone;
    use uuid::Uuid;

    fn timestamp(seconds: i64) -> DateTime<Utc> {
        Utc.timestamp_opt(seconds, 0).unwrap()
    }

    fn expected() -> ExpectedCohortPullRequest {
        ExpectedCohortPullRequest {
            workflow_run_id: WorkflowRunId(Uuid::new_v4()),
            stage_instance_id: StageInstanceId(Uuid::new_v4()),
            unit_id: "api".into(),
            repository_key: "api".into(),
            repository: ForgeRepositoryIdentity {
                provider: ForgeProvider::Github,
                owner: "acme".into(),
                name: "api".into(),
            },
            number: 42,
            url: "https://github.com/acme/api/pull/42".into(),
            head_branch: "cohort/api".into(),
            base_branch: "epic/parity".into(),
        }
    }

    fn observation(state: ObservedPullRequestState) -> PullRequestObservation {
        PullRequestObservation {
            provider: ForgeProvider::Github,
            owner: "acme".into(),
            name: "api".into(),
            number: 42,
            url: "https://github.com/acme/api/pull/42".into(),
            head_branch: "cohort/api".into(),
            base_branch: "epic/parity".into(),
            head_sha: Some("deadbeef".into()),
            state,
            source: PullRequestObservationSource::Webhook,
            observed_at: timestamp(200),
            merged_at: None,
        }
    }

    #[test]
    fn parses_only_canonical_github_pull_request_urls() {
        assert_eq!(
            github_pull_request_identity("https://github.com/acme/api/pull/42/"),
            Some(("acme".into(), "api".into(), 42))
        );
        for invalid in [
            "http://github.com/acme/api/pull/42",
            "https://github.com/acme/api/issues/42",
            "https://github.com/acme/api/pull/0",
            "https://github.com/acme/api/pull/42/files",
        ] {
            assert_eq!(github_pull_request_identity(invalid), None, "{invalid}");
        }
    }

    #[test]
    fn only_merged_into_expected_epic_branch_completes() {
        let expected = expected();
        let mut merged = observation(ObservedPullRequestState::Merged);
        merged.merged_at = Some(timestamp(201));
        assert_eq!(
            reconcile_pull_request(&expected, &merged, None),
            ReconciliationDecision::Complete
        );

        let mut wrong_base = merged.clone();
        wrong_base.base_branch = "main".into();
        assert!(matches!(
            reconcile_pull_request(&expected, &wrong_base, None),
            ReconciliationDecision::Mismatch(PullRequestMismatch {
                kind: PullRequestMismatchKind::BaseBranchMismatch,
                ..
            })
        ));

        let closed = observation(ObservedPullRequestState::ClosedUnmerged);
        assert!(matches!(
            reconcile_pull_request(&expected, &closed, None),
            ReconciliationDecision::Mismatch(PullRequestMismatch {
                kind: PullRequestMismatchKind::ClosedWithoutMerge,
                ..
            })
        ));
    }

    #[test]
    fn rejects_other_prs_and_repositories() {
        let expected = expected();
        let mut stale_pr = observation(ObservedPullRequestState::Open);
        stale_pr.number = 41;
        stale_pr.url = "https://github.com/acme/api/pull/41".into();
        assert!(matches!(
            reconcile_pull_request(&expected, &stale_pr, None),
            ReconciliationDecision::Mismatch(PullRequestMismatch {
                kind: PullRequestMismatchKind::PullRequestMismatch,
                ..
            })
        ));

        let mut other_repo = observation(ObservedPullRequestState::Open);
        other_repo.name = "web".into();
        other_repo.url = "https://github.com/acme/web/pull/42".into();
        assert!(matches!(
            reconcile_pull_request(&expected, &other_repo, None),
            ReconciliationDecision::Mismatch(PullRequestMismatch {
                kind: PullRequestMismatchKind::RepositoryMismatch,
                ..
            })
        ));
    }

    #[test]
    fn accepts_github_identity_case_and_trailing_slash_variants() {
        let expected = expected();
        let mut equivalent = observation(ObservedPullRequestState::Open);
        equivalent.owner = "ACME".into();
        equivalent.name = "Api".into();
        equivalent.url = "https://github.com/ACME/Api/pull/42/".into();
        assert_eq!(
            reconcile_pull_request(&expected, &equivalent, None),
            ReconciliationDecision::Waiting
        );
    }

    #[test]
    fn ignores_observations_older_than_durable_state() {
        let expected = expected();
        let current = observation(ObservedPullRequestState::Open);
        let previous = CohortPullRequestReconciliation {
            workflow_run_id: expected.workflow_run_id,
            stage_instance_id: expected.stage_instance_id,
            unit_id: expected.unit_id.clone(),
            repository_key: expected.repository_key.clone(),
            observation: current,
            mismatch: None,
            completed_at: None,
            updated_at: timestamp(200),
        };
        let mut old = observation(ObservedPullRequestState::Merged);
        old.observed_at = timestamp(100);
        old.merged_at = Some(timestamp(101));
        assert!(matches!(
            reconcile_pull_request(&expected, &old, Some(&previous)),
            ReconciliationDecision::IgnoreStale(PullRequestMismatch {
                kind: PullRequestMismatchKind::StaleObservation,
                ..
            })
        ));
    }

    #[test]
    fn duplicate_current_merged_observation_remains_idempotently_complete() {
        let expected = expected();
        let mut merged = observation(ObservedPullRequestState::Merged);
        merged.merged_at = Some(timestamp(201));
        let previous = CohortPullRequestReconciliation {
            workflow_run_id: expected.workflow_run_id,
            stage_instance_id: expected.stage_instance_id,
            unit_id: expected.unit_id.clone(),
            repository_key: expected.repository_key.clone(),
            observation: merged.clone(),
            mismatch: None,
            completed_at: Some(timestamp(202)),
            updated_at: timestamp(202),
        };
        assert_eq!(
            reconcile_pull_request(&expected, &merged, Some(&previous)),
            ReconciliationDecision::Complete
        );
    }
}
