use std::path::Path;
use std::sync::OnceLock;

use tokio::process::Command;
use tokio::sync::Mutex;

use crate::types::{EpicRepositoryBinding, EpicWorkflowProfile};

#[async_trait::async_trait]
pub(crate) trait EpicBranchPreflight: Send + Sync {
    async fn ensure(&self, profile: &EpicWorkflowProfile) -> crate::Result<()>;
}

pub(crate) struct GitEpicBranchPreflight;

#[cfg(test)]
pub(crate) struct NoopEpicBranchPreflight;

#[cfg(test)]
#[async_trait::async_trait]
impl EpicBranchPreflight for NoopEpicBranchPreflight {
    async fn ensure(&self, _profile: &EpicWorkflowProfile) -> crate::Result<()> {
        Ok(())
    }
}

static EPIC_BRANCH_PREFLIGHT: OnceLock<Mutex<()>> = OnceLock::new();

#[derive(Debug, Clone, PartialEq, Eq)]
struct GitOutput {
    stdout: String,
    stderr: String,
    code: Option<i32>,
}

async fn git(repository_path: &Path, args: &[&str]) -> crate::Result<GitOutput> {
    let output = Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(args)
        .output()
        .await
        .map_err(|error| {
            crate::Error::Validation(format!(
                "failed to run git in {}: {error}",
                repository_path.display()
            ))
        })?;
    Ok(GitOutput {
        stdout: String::from_utf8_lossy(&output.stdout).trim().to_owned(),
        stderr: String::from_utf8_lossy(&output.stderr).trim().to_owned(),
        code: output.status.code(),
    })
}

fn require_success(operation: &str, output: GitOutput) -> crate::Result<GitOutput> {
    if output.code == Some(0) {
        return Ok(output);
    }
    Err(crate::Error::Validation(format!(
        "{operation} failed (exit {:?}): {}",
        output.code, output.stderr
    )))
}

async fn remote_branch_exists(
    repository: &EpicRepositoryBinding,
    branch: &str,
) -> crate::Result<bool> {
    let reference = format!("refs/heads/{branch}");
    let output = require_success(
        "git ls-remote",
        git(
            &repository.repository_path,
            &["ls-remote", "--heads", "origin", &reference],
        )
        .await?,
    )?;
    Ok(!output.stdout.is_empty())
}

async fn fetch_remote_branch(
    repository: &EpicRepositoryBinding,
    branch: &str,
) -> crate::Result<()> {
    let refspec = format!("+refs/heads/{branch}:refs/remotes/origin/{branch}");
    require_success(
        &format!("fetching latest origin/{branch}"),
        git(&repository.repository_path, &["fetch", "origin", &refspec]).await?,
    )?;
    Ok(())
}

async fn verify_latest_base_is_ancestor(repository: &EpicRepositoryBinding) -> crate::Result<()> {
    let base = format!("origin/{}", repository.base_branch);
    let epic = format!("origin/{}", repository.epic_branch);
    let output = git(
        &repository.repository_path,
        &["merge-base", "--is-ancestor", &base, &epic],
    )
    .await?;
    match output.code {
        Some(0) => Ok(()),
        Some(1) => Err(crate::Error::Validation(format!(
            "existing epic branch '{}' does not contain the latest remote base '{}'/{}",
            repository.epic_branch, repository.repository_key, repository.base_branch
        ))),
        _ => Err(crate::Error::Validation(format!(
            "could not verify ancestry for epic branch '{}': {}",
            repository.epic_branch, output.stderr
        ))),
    }
}

async fn ensure_repository_epic_branch(repository: &EpicRepositoryBinding) -> crate::Result<()> {
    fetch_remote_branch(repository, &repository.base_branch).await?;
    if remote_branch_exists(repository, &repository.epic_branch).await? {
        fetch_remote_branch(repository, &repository.epic_branch).await?;
        return verify_latest_base_is_ancestor(repository).await;
    }

    let source = format!("origin/{}", repository.base_branch);
    let destination = format!("refs/heads/{}", repository.epic_branch);
    let refspec = format!("{source}:{destination}");
    let push = git(&repository.repository_path, &["push", "origin", &refspec]).await?;
    if push.code != Some(0) && !remote_branch_exists(repository, &repository.epic_branch).await? {
        return Err(crate::Error::Validation(format!(
            "creating epic branch '{}' from latest origin/{} failed (exit {:?}): {}",
            repository.epic_branch, repository.base_branch, push.code, push.stderr
        )));
    }
    fetch_remote_branch(repository, &repository.epic_branch).await?;
    verify_latest_base_is_ancestor(repository).await
}

#[async_trait::async_trait]
impl EpicBranchPreflight for GitEpicBranchPreflight {
    async fn ensure(&self, profile: &EpicWorkflowProfile) -> crate::Result<()> {
        let _guard = EPIC_BRANCH_PREFLIGHT
            .get_or_init(|| Mutex::new(()))
            .lock()
            .await;
        for repository in &profile.repositories {
            ensure_repository_epic_branch(repository).await?;
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::process::Command as SyncCommand;

    use chrono::Utc;
    use uuid::Uuid;

    use super::*;
    use crate::types::{
        EpicLifecycleState, EpicWorkflowProfileId, FinalMergePolicy, FinalMergeState,
        ForgeProvider, ForgeRepositoryIdentity, WorkflowRunId,
    };

    fn run_git(path: &Path, args: &[&str]) -> String {
        let output = SyncCommand::new("git")
            .arg("-C")
            .arg(path)
            .args(args)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "git {:?} failed: {}",
            args,
            String::from_utf8_lossy(&output.stderr)
        );
        String::from_utf8_lossy(&output.stdout).trim().to_owned()
    }

    fn profile(repository_path: &Path, base_branch: &str) -> EpicWorkflowProfile {
        let run_id = WorkflowRunId(Uuid::new_v4());
        let now = Utc::now();
        EpicWorkflowProfile {
            id: EpicWorkflowProfileId(run_id.0),
            workflow_run_id: run_id,
            title: "Topology test".into(),
            slug: "topology-test".into(),
            lifecycle_state: EpicLifecycleState::Active,
            final_merge_policy: FinalMergePolicy::Guarded,
            repositories: vec![EpicRepositoryBinding {
                repository_key: "repo".into(),
                repository_path: repository_path.to_path_buf(),
                base_branch: base_branch.into(),
                epic_branch: "epic/topology-test".into(),
                forge_repository: Some(ForgeRepositoryIdentity {
                    provider: ForgeProvider::Github,
                    owner: "acme".into(),
                    name: "repo".into(),
                }),
                final_pull_request: None,
                final_merge_state: FinalMergeState::Pending,
            }],
            created_at: now,
            updated_at: now,
        }
    }

    fn repository_fixture(base_branch: &str) -> (tempfile::TempDir, std::path::PathBuf) {
        let root = tempfile::tempdir().unwrap();
        let remote = root.path().join("remote.git");
        let work = root.path().join("work");
        run_git(root.path(), &["init", "--bare", remote.to_str().unwrap()]);
        run_git(root.path(), &["init", work.to_str().unwrap()]);
        run_git(&work, &["config", "user.email", "test@example.com"]);
        run_git(&work, &["config", "user.name", "Test"]);
        run_git(&work, &["config", "commit.gpgsign", "false"]);
        run_git(&work, &["checkout", "-b", base_branch]);
        run_git(&work, &["commit", "--allow-empty", "-m", "base"]);
        run_git(
            &work,
            &["remote", "add", "origin", remote.to_str().unwrap()],
        );
        run_git(&work, &["push", "-u", "origin", base_branch]);
        (root, work)
    }

    #[tokio::test]
    async fn creates_missing_epic_from_latest_configured_remote_base() {
        let (_root, work) = repository_fixture("develop");
        let profile = profile(&work, "develop");

        GitEpicBranchPreflight.ensure(&profile).await.unwrap();

        let epic = run_git(&work, &["rev-parse", "origin/epic/topology-test"]);
        let base = run_git(&work, &["rev-parse", "origin/develop"]);
        assert_eq!(epic, base);
    }

    #[tokio::test]
    async fn rejects_existing_epic_that_lacks_latest_remote_base_tip() {
        let (_root, work) = repository_fixture("main");
        let profile = profile(&work, "main");
        GitEpicBranchPreflight.ensure(&profile).await.unwrap();

        run_git(&work, &["commit", "--allow-empty", "-m", "new base"]);
        run_git(&work, &["push", "origin", "main"]);

        let error = GitEpicBranchPreflight.ensure(&profile).await.unwrap_err();
        assert!(error
            .to_string()
            .contains("does not contain the latest remote base"));
    }
}
