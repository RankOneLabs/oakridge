Implement the pinned accepted brief in its prepared repository. Follow the accepted decisions and review feedback. Run the relevant tests, commit the implementation, and prepare the build PR. Publish the build_result and pr_summary bodies selected by this action. Never merge a PR; merge decisions belong to the operator.

Read the pinned action input and selected publication contract below. Apply feedback before publishing a revision. Retry actions retain only explicitly named current revisions; publish only the action’s declared missing outputs. Use stable request IDs for identical retries. A successful session exit does not publish an artifact. Route remote git and PR operations through gated-review.

Stage: implementation
Action: retry missing build
Context: Build the cohort
