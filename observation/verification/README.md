# Live verification

One program, `proof.ts`, holds every live proof. It runs on the stack that
`scripts/oakridge-shadow` starts and reuses that shadow's resolved state across
scenarios and restarts. There is no second launcher, database setup or capability
set: extend these scenarios rather than adding another entrypoint. Real provider
requests happen only here, never in an offline test command.

```sh
bun observation/verification/proof.ts runtime
bun observation/verification/proof.ts live
bun observation/verification/proof.ts source-run --input input.json [--through analysis|plan|brief|assessment]
bun observation/verification/proof.ts registration --input observation/verification/inputs/registration-audit.json
bun observation/verification/proof.ts grading --input observation/verification/inputs/grading-audit.json
bun observation/verification/proof.ts relations --input observation/verification/inputs/relations-audit.json --shared-input observation/verification/inputs/relations-shared-audit.json
bun observation/verification/proof.ts workspace --input observation/verification/inputs/grading-audit.json
```

Configure the shadow with the usual `OAKRIDGE_SHADOW_*` variables. Set
`OAKRIDGE_SHADOW_PROVIDER_ENV_FILE` when running from a worktree, which has no
`observation/.env` of its own. The program takes its paths and ports from
`scripts/oakridge-shadow --print-state`, and reads token files from that state
directory only.

Each proof writes `reports/<proof_id>/report.json`, and exits zero only if the
requested scenario passed. A failed proof keeps its report and `launcher.log`,
which is not committed.

| Scenario | What it proves | Stack |
| --- | --- | --- |
| `runtime` | Isolation and supervision on the real services: shadow-owned role, database, ports and tokens; kbbl reporting observation down after it is killed; DBOS serving and a real run launching and canceling meanwhile; the run not reading as captured meanwhile; a restart reusing the same state; ordered delivery catching up to the authority and covering that run. | Starts and stops its own, and refuses a running one. |
| `live` | The prerequisites of a real-provider proof: a reachable service, registered graders and both kbbl capabilities. | Attaches to a running stack, or starts one. |
| `registration` | Startup registration, capture pins and per-question evidence across a `graders.json` edit and restart, with a required lookup waiting on a real capture. Clones the input's primary repository to a disposable path under the system temp directory, with the same origin, and launches both runs from it. Starts on the committed selection; launches the first run and stops observation once it has launched, so the run reaches its assessment unobserved; withholds the clone (renames it away from its launch path) and restarts, so observation captures the whole run, every captured item carries exactly the questions its kind applies, pinned to the selection in force, and every file-citing question waits with `repository_unavailable` while the rest are ready; edits every grader's instructions in `graders.json` and restarts, checking the edit registered new definitions and kept the old ones, and that the first run kept its pins, its frozen evidence and its waits; supplies the clone and restarts, checking every waiting question became ready on its capture-time pins and that each of its file references matches what the proof reads itself from the clone: the assessment's `head_sha`, the cited path and line range, and the content there; launches a second run with observation up, which must take the edited selection, reading it every ten seconds to check evidence frozen earlier stays ready and unchanged through every later revision and task link; and checks no execution, provider attempt or answer exists throughout. A capture where nothing waits, or a wait that never ends, fails. Restores `graders.json` and the clone whatever happens. Records `registrations`, `pins` (provenance at every checkpoint) and `frozen_evidence` (each set's full content when first seen ready). Spends the real agent turns of two runs through assessment. | Starts, restarts and stops its own, and refuses a running one. |
| `grading` | Automatic grading with real provider requests, continuing `registration` with executions. Starts on the committed selection. An enabled run driven only to its analysis is answered by the configured provider before it has any task, each answer using the evaluator pinned at capture, with the run's request count matching its attempts and its authority events unchanged by grading. A run with grading off gets human-ready evidence, reads `grading_off` and sends nothing. An enabled run captured through its assessment with observation down and its launch repository withheld answers its ready questions while file-citing ones wait unadmitted. An edit of `graders.json` (new instructions, and `estimated_cost_per_call` 3 so one request fits the $5 run allowance) and a restart leave those waits unadmitted and send nothing again; supplying the repository and restarting answers them with the evaluators pinned at capture. A later enabled run captured under the edit is measured with the new evaluators: one request is answered and what cannot fit is `budget_deferred` with no request. A restart then admits, sends and regrades nothing for any run. Last, the provider settings point at an address that never answers, observation is killed while a claim's request is in flight, and the stack restarts with a key the provider refuses: the expired claim is reclaimed with its request kept as a retry, every refusal is a recorded request, retries are exhausted and no grade exists, with authority events unchanged. Then, under an edit with `estimated_cost_per_call` 2 (two requests fit the $5 allowance), an enabled run's claim is left in flight against the unanswering address and observation is killed; the proof acts as a second observation worker on the shadow's own database (its provisioned role, the shadow's tenant, the default controls, the real provider settings, the same store and worker code). It fires more simultaneous claims than there is due work: exactly what fits beside the killed claim's charged request is claimed and the rest are `budget_deferred`, with each reservation counted once. Once every lease has expired another worker reclaims the contested execution as its next claim attempt; the earlier owner's claim, the reclaiming owner's older claim attempt and the killed service's claim are each refused by request marking, completion and failure alike; and the reclaiming worker sends a real request and completes it with an observation, which the restarted service serves without sending anything more, with authority events unchanged. Records `measurements` (each item's served status with execution, attempt and observation ids), `spend` (each run's committed choice, exact captured config, spend, request count and statuses), `pins` (every question and evaluator pin) at every checkpoint, `frozen_evidence` (each evidence set's references as first served ready, which every later checkpoint must serve unchanged), `launch_configs` (each run's captured config beside the authority's committed one, which must match) and `second_worker` (every claim call, stale settlement and spend readback). A checkpoint whose measurements lack pins or whose ready questions lack frozen references fails the proof. Restores `graders.json`, the repository and the provider settings whatever happens. Spends real agent turns of five analysis runs and one run through assessment. | Starts, restarts and stops its own, and refuses a running one. |
| `relations` | Explicit late links and composites on a real run with real provider answers: a finding answered before any task, a refused mapping before approval, an approval that links nothing, an explicit mapping whose composite reads the original answer with identity, pins, evidence, executions, attempts and request counts unchanged beside an unlinked control, and a second mapping journaled with observation down and delivered once across a whole-stack restart. Then a second real run from `--shared-input`: its tasks approval carries explicit links, its plan and both briefs are sent back and really revised, and two cohorts sharing one task reach their assessments, read through the composite, lineage and every page window, with integration pending. It stops before any operator acceptance of an assessment or merge confirmation. Last, the shared-task matrix as a supplement, in a tenant of its own on synthetic revisions labelled as such: integration final, corrections and disagreement. | Starts its own stack; refuses one already up. |
| `workspace` | The operator flow, on real services and the real PWA. A run with grading off takes a human answer and sends nothing. An enabled run reaches its assessment with observation down, with one plan review sent back and the rest accepted, none of which creates a grade. With its repository withheld, a not-ready question refuses its answer with its reason, in the API and the browser, while a ready question takes one. With it supplied, the configured provider answers. On one real assessment finding, addressed only by revision and path: an authenticated human answer on the machine's frozen evidence, a refused invalid choice, a duplicate id carrying spoofed reviewer and evaluator fields that changes nothing, and a linked correction, with counts of answers, executions, provider requests and authority events read at each step. Read and grade capabilities are shown separate, and the real forwarding code under a control token refuses before forwarding; the shadow's own kbbl runs in its loopback control policy. In a real browser: hidden views omit answers and composites from the text and DOM, reveal works first, the machine and human answers read back with their identities, an answer and correction are saved in the page only on acknowledgment, each viewer opens the same occurrence, and a composite count opens raw answers. Records `workspace` (ids, submissions, counts, composites, browser steps and screenshot paths). Also scans every retained definition for a discarded review field. | Starts, restarts and stops its own, and refuses a running one. |
| `source-run` | Launches the committed development workflow to its target artifact, cancels it, and requires the ordered feed to cover the run. Retains `run.json`, `inspect.json` and `authority-rows.json` under `source-run/`. Spends real agent turns and needs the installed Codex agent's authentication. | Attaches, or starts one. |

`live` fails on a missing key, invalid grader or unavailable database, with the
launcher's reason in its checks, even though DBOS and kbbl stay up. A healthy
service reports the graders it registered from `observation/graders.json`.

`registration` needs an input whose sessions change nothing outside the shadow.
`inputs/registration-audit.json` is the one used: an audit of this branch's pull request
whose spec forbids edits, commits, pushes and pull requests, and whose `build_base` is the
pull request's existing base, so `prepare` finds it on the forge and pushes nothing; the builder
checks out the pull request's head locally to inspect it. Analysis findings are captured and frozen before the run has tasks, so
the second run's check on evidence frozen earlier is the late-link case: their Relevance evidence
must stay unchanged through every later task, plan, brief and assessment link. On a real capture the
ordered feed always delivers a build before its assessment, so Correctness cannot wait on its
subject there; that same-finding case is proven through the real service in
`observation/tests/grading-startup.test.ts`, and the proof reports how many findings it saw in that
state.

`source-run` checks that observation is reachable before it launches, so a service
already down fails without spending a turn. After canceling, it waits up to two
minutes for `run-capture.ts` to find every authority event of the run recorded by the
service, none of them `unmapped`, the service cursor at or past the run's last event,
and the target revision served back through the read capability. A cursor alone is
not enough, and neither is a run that reached its target on a healthy DBOS and kbbl.
A failure keeps `run_capture` in the report: the undelivered event ids, unmapped
reasons, failed reads, observation health, the launcher's status and the publisher's
latest refusals. Those refusals appear only when this proof started the stack, since
only then does it hold the launcher's log.

## Contracts

`proof-contract.ts` holds the named types: `LauncherState` is what `--print-state`
emits, `ObservationStatus` is `observation-status.json`, and `ProofReport` is the
report. `shadow-session.ts` holds all IO behind `ProofIo`, so scenario logic is
tested offline in `observation/tests/verification-proof.test.ts`.

A report records the source revision, the resolved launcher state, each check, and
`ScenarioEvidence`: run and definition ids, the authority head and service cursor,
the run's event-by-event capture, authority event counts, source revisions, item paths, pinned definitions,
execution, provider-attempt and observation ids, the provider request count and
PWA readback. Every value is read back from a running service. A value not yet
observed stays empty or null: a provider that returns no request id records null,
and `provider_request_count` is null until a scenario counts requests. Reports
carry no token, key or connection secret; `runProof` scans for those values,
removes any it finds and fails the report.

## What remains

`pending` in every report lists what this program does not prove, so a passed report
cannot read as a complete proof. `workspace` holds the first complete case; `grading`
and `relations`, on the same state, hold budget, recovery, pin swap, late links and
shared-task composites.

| Pending scenario | Owner |
| --- | --- |
| `two-real-cohorts-through-integration` | operator: a verification run may not merge, and a run's cohorts are its planner's to choose, so no real run reaches a second cohort or integration. `relations` proves those reads on the shadow's database with synthetic revisions, labelled as such. |
| `same-finding-correctness-awaits-subject-build` | operator: live assessments are published with subject null, and the ordered feed captures a named subject before its assessment, so a real run cannot leave Correctness waiting while its Evidence support is answered; it is proven offline in `observation/tests/execution-lifecycle.test.ts` |

## Review endpoint

`gated-review-tools.json` is the endpoint proof: the complete `tools/list` result
from the exact `OAKRIDGE_GATED_REVIEW_URL` every agent session receives. The server
has no client authentication, so the check sends no credential:

```sh
OAKRIDGE_GATED_REVIEW_URL=<url> bun observation/verification/gated-review-tools.ts \
  --run-id <run> --unit-id <unit>
```

It negotiates a real MCP session, follows every continuation page and calls no
tool. The report retains the server's initialize and `tools/list` results, the
advertised names and its assertions: `merge_pr` and `mark_merge_ready` are absent,
the agent catalogue is present, and `selectMcpServers` supplies the URL unchanged
with no header. Status is `passed`, `failed` for a complete list that breaks an
assertion, or `incomplete` for a missing or unreachable endpoint, protocol failure
or unfinished list. Only `passed` exits zero. The check needs no database, launcher
or provider.
