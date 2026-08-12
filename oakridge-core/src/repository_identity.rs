use std::path::Path;
use std::time::Duration;

use tokio::process::Command;
use tokio::time::timeout;

use crate::types::{ForgeProvider, ForgeRepositoryIdentity};

const GIT_COMMAND_TIMEOUT: Duration = Duration::from_secs(2);

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct LocalRepositoryIdentity {
    pub forge_repository: ForgeRepositoryIdentity,
    pub base_branch: Option<String>,
}

pub fn github_identity_from_remote(remote: &str) -> Option<ForgeRepositoryIdentity> {
    let remote = remote.trim().trim_end_matches('/');
    let path = remote
        .strip_prefix("git@github.com:")
        .or_else(|| remote.strip_prefix("ssh://git@github.com/"))
        .or_else(|| remote.strip_prefix("https://github.com/"))
        .or_else(|| remote.strip_prefix("http://github.com/"))?;
    let path = path.strip_suffix(".git").unwrap_or(path);
    let (owner, name) = path.split_once('/')?;
    if owner.is_empty() || name.is_empty() || name.contains('/') {
        return None;
    }
    Some(ForgeRepositoryIdentity {
        provider: ForgeProvider::Github,
        owner: owner.to_owned(),
        name: name.to_owned(),
    })
}

async fn git_output(repository_path: &Path, args: &[&str]) -> Option<String> {
    let output = timeout(
        GIT_COMMAND_TIMEOUT,
        Command::new("git")
            .arg("-C")
            .arg(repository_path)
            .args(args)
            .output(),
    )
    .await
    .ok()?
    .ok()?;
    if !output.status.success() {
        return None;
    }
    String::from_utf8(output.stdout)
        .ok()
        .map(|value| value.trim().to_owned())
}

pub async fn resolve_local_repository_identity(
    repository_path: &Path,
) -> Option<LocalRepositoryIdentity> {
    let remote = git_output(repository_path, &["remote", "get-url", "origin"]).await?;
    let forge_repository = github_identity_from_remote(&remote)?;
    let base_branch = git_output(
        repository_path,
        &["symbolic-ref", "--short", "refs/remotes/origin/HEAD"],
    )
    .await
    .and_then(|branch| branch.strip_prefix("origin/").map(str::to_owned));
    Some(LocalRepositoryIdentity {
        forge_repository,
        base_branch,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_supported_github_remote_forms() {
        for remote in [
            "git@github.com:RankOneLabs/oakridge.git",
            "ssh://git@github.com/RankOneLabs/oakridge.git",
            "https://github.com/RankOneLabs/oakridge.git",
        ] {
            let identity = github_identity_from_remote(remote).unwrap();
            assert_eq!(identity.owner, "RankOneLabs");
            assert_eq!(identity.name, "oakridge");
        }
    }

    #[test]
    fn rejects_non_github_and_malformed_remotes() {
        for remote in ["git@gitlab.com:acme/api.git", "https://github.com/acme", ""] {
            assert_eq!(github_identity_from_remote(remote), None);
        }
    }
}
