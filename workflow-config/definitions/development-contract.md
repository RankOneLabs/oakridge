# Development flow behavior contract

Source: the artifact body contracts, selected operation contracts, and the generic
`development.json` bundle. `development-independent-siblings.json` changes failure
policy and shared capacity from four to two.

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

The canonical bundle uses selected execution authority for body publication and
unchanged assessment evidence. Every operator target combines current revision
identity with persisted PR observations where applicable. Child entry, terminal
notifications, dependency prerequisites, and descendant cancellation are generic
source declarations executed by the runtime, rather than development-specific
adapter branches. Collection membership comes from accepted briefs; final
integration groups completed work by repository. Failed verdict acceptance is an
operator decision, while merge confirmation remains tied to the accepted head.

The authority baseline namespaces collection members by their collection key, so
preparation and final integration may reuse repository keys under one parent.
This repository's migration command applies the baseline to an empty authority
database and exits successfully on repeat when its recorded digest still matches
the baseline file. A changed file against an applied database is an error. The
frame and response transports are bounded at
64 MiB — a line-reader guard far above any legitimate scope state, not a domain
limit — with both limits exported into the generated adapter contract.
