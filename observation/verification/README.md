# Live verification

One program, `proof.ts`, holds every live proof. It runs on the stack that
`scripts/oakridge-shadow` starts and reuses that shadow's resolved state across
scenarios and restarts. There is no second launcher, database setup or capability
set: extend these scenarios rather than adding another entrypoint. Real provider
requests happen only here, never in an offline test command.

```sh
bun observation/verification/proof.ts runtime
bun observation/verification/proof.ts live
bun observation/verification/proof.ts source-run --input input.json [--through plan|brief|assessment]
bun observation/verification/proof.ts registration --input input.json [--through plan|brief|assessment]
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
| `registration` | Startup registration, capture pins and per-question evidence across a `graders.json` edit and restart. Starts on the committed selection and checks health reports exactly the graders it plans; captures a real `source-run` (default `--through plan`) and reads back every pin, readiness and evidence reference through the read capability; edits every grader's instructions in `graders.json` and restarts; checks the edit registered new definitions and kept the old ones, that the first run's pins and frozen evidence are unchanged and that questions waiting at capture keep their pins as they become ready; captures a second run, which must take the edited selection; and checks no execution, provider attempt or answer exists throughout. Restores `graders.json` whatever happens. Records `registrations`, `pins` and `provider_request_count`. Spends the same real agent turns as two `source-run`s, whose `prepare` step creates the run's base branch on the input's forge. Without `--input` it still proves startup, the swap and definition retention on the real service, and fails its capture checks. | Starts, restarts and stops its own, and refuses a running one. |
| `source-run` | Launches the committed development workflow to its target artifact, cancels it, and requires the ordered feed to cover the run. Retains `run.json`, `inspect.json` and `authority-rows.json` under `source-run/`. Spends real agent turns and needs the installed Codex agent's authentication. | Attaches, or starts one. |

`live` fails on a missing key, invalid grader or unavailable database, with the
launcher's reason in its checks, even though DBOS and kbbl stay up. A healthy
service reports the graders it registered from `observation/graders.json`.

`registration` drives only real captures, so it observes whatever readiness those
runs produce. A real run's inputs are normally all present when it is captured, so
its questions pass through `collection_pending` to `ready` and the check on waiting
questions may report none waiting. The required-lookup cases, an unreadable
repository, a missing build subject and their later arrival, are proven through the
real service and HTTP in `observation/tests/grading-startup.test.ts`, which this
scenario does not replace; `not-ready-arrival-on-real-capture` stays pending until a
real capture is observed waiting on one.

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

`pending` in every report lists what this program does not prove yet, so a passed
`runtime` report cannot read as a complete proof. The first complete case is one
assessment finding from a fresh service through startup registration, the ordered
capture feed, exact evidence, and a real provider answer and an authenticated human
answer both visible in the PWA without task or cohort context. The wider matrix then
runs on the same state: on/off, readiness, pin swap, recovery, budget, correction,
failure, lineage and composites, and reveal.

| Pending scenario | Owner |
| --- | --- |
| `not-ready-arrival-on-real-capture` | configured-question-evidence |
| `real-provider-requests-and-recovery` | automatic-execution-lifecycle |
| `relations-and-composites` | task-lineage-composites |
| `first-assessment-finding-end-to-end`, `human-grading-and-pwa-readback` | operator-item-workspace |

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
