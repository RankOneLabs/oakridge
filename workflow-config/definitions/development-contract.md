# Development flow behavior contract

Source: `dev_flow_v15.json` as supplied for this cohort, its 18 checked-in
`prompts/dev-flow/v15/` files, and the existing operator review request types.
The brief calls these twenty prompt files; the source tree contains eighteen.

1. Repository preparation runs first as a selected `repository.prepare` operation.
   Its successful repository references feed later work; interruption allows an
   explicit retry, while cancellation and abandonment terminate the work.
2. Analysis follows preparation. Planning follows accepted analysis and
   preparation. Each publishes a revision, is reviewed against that exact
   revision, and supports feedback revision and interrupted execution retry.
3. Brief writing follows accepted planning and preparation. It publishes a
   collection keyed by `cohort_id`; acceptance targets the complete collection,
   with membership and dependency consistency checked before implementation.
4. Implementation fans out one child per accepted brief key. The child's
   repository and dependencies come from the accepted brief. Four reservations
   are held across execution, interruption, review, assessment, and merge wait;
   they are released at terminal completion, cancellation, or failure.
5. Build publication requires both `build_result` and `pr_summary`. Review
   targets their exact revisions and the PR head. Build feedback starts a new
   build revision and invalidates the old assessment. Accepted build evidence
   is captured before assessment starts.
6. Assessment publication carries a verdict including `fail`. Operator
   acceptance of the exact assessment revision and accepted build is
   authoritative for every verdict. Discussion starts a separate assessment
   action, retains the accepted build, and publishes a new assessment revision
   or explicit unchanged evidence. Implementation-change feedback returns to
   the build action and clears assessment acceptance.
7. A closed, unmerged PR permits the parent to start a replacement build; merge
   completion requires the accepted head. Final integration runs once for each
   repository used by completed implementation work and confirms the final PR
   against its reviewed head.
8. The default parent policy cancels independent siblings after one failure.
   A separate bundle continues independent siblings and aggregates failures.
   Capacity is configured, and a separate bundle varies it from four.
9. Retry after partial publication may retain only explicitly named current
   revisions and publish only missing outputs. Fenced or unrelated output is
   never inherited.

The current bundle declares the stage graph, selected repository operation,
review commands, two distinct feedback actions, prompt references, and a
configurable shared capacity pool. Its remaining gaps are material: brief
fan-out currently reads launch input rather than the accepted collection;
the parent failure branch does not cancel active siblings; session identity
and publication details are not assembled by the adapter; and the old v15
definition still has UI imports. The bundle must not replace v15 as the
canonical runtime definition until those paths work and are tested end to end.
