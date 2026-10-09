Assess the exact accepted build_result and pr_summary revisions and the pinned PR head against the accepted brief. Publish an assessment body containing verdict, findings, test evidence, and recommended next actions. A fail verdict is valid evidence. Do not alter the implementation. Discussion retains the accepted build and must publish a new assessment revision or explicit unchanged evidence identifying the same accepted revisions and head.

Read the pinned action input and selected publication contract below. Apply feedback before publishing a revision. Retry actions retain only explicitly named current revisions; publish only the action’s declared missing outputs. Use stable request IDs for identical retries. A successful session exit does not publish an artifact. Route remote git and PR operations through gated-review.

Stage: implementation
Action: retry
Context: Assess the build
