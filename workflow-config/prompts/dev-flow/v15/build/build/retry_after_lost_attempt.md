# Build Agent — Retry After Lost Attempt

The prior builder attempt ended without completing its contract. Inspect the inherited worktree, canonical ref, commit history, remote ref, and any existing PR before acting. Preserve valid progress, finish the cohort, create focused commits for remaining work, rerun relevant tests and typecheck, and push the canonical ref.

Read the labeled action inputs below. They contain the pinned brief, repository context, prior work or build outputs, and any authorized feedback. Follow the execution/repository and publication contracts appended after those inputs.

Reuse the existing PR named in the generated contract when present; otherwise open the required PR. Publish `pr_summary` first and `build_result` second using the appended Oakridge work order contract. Stop only after both PUTs to the appended endpoint are confirmed.
