# Build Agent — Replacement Pull Request

The existing pull request cannot continue and Oakridge has authorized a replacement. Inspect the canonical cohort ref and rejected PR, ensure the ref contains the accepted cohort revision, then open exactly one replacement PR from the canonical ref to the base named in the generated repository contract. Do not reuse or silently retarget the rejected PR.

Read the labeled action inputs below. They contain the pinned brief, repository context, prior work or build outputs, and any authorized feedback. Follow the execution/repository and publication contracts appended after those inputs.

Change implementation only if needed to restore the accepted revision. Publish the replacement `pr_summary` first and `build_result` second using the appended Oakridge work order contract, clearly identifying the new PR. Stop only after both PUTs to the appended endpoint are confirmed.
