# Core v2 criteria baseline

This baseline is recorded at the `epic/core-v2` tip `897dfa6870544013df670a3ef337b391e630e55a`. Later cohorts can cite these bounds without treating unrelated existing code or future semantic changes as refactor failures.

## Section 1 vocabulary audit

Run from the repository root:

```sh
rg -n -i 'legacy|scopes' kbbl oakridge-dbos workflow-core workflow-config
```

The four matching lines at the baseline tip are quoted verbatim below. Their order is not part of the baseline; `rg` can emit files in a different order during a parallel walk.

```text
oakridge-dbos/src/workflows/engine-version.ts:47: * The DBOS application version scopes workflow recovery: a process only resumes
kbbl/core/acp/__fixtures__/agent-config-options.ts:66:      // 1M entitlement present, legacy models withheld.
kbbl/core/acp/__fixtures__/agent-config-options.ts:70:      // 1M entitlement absent: hintless current ids, legacy models exposed,
kbbl/core/acp/runtime-vocabulary.test.ts:70: * Models only *some* variants advertise (the legacy 4.x ids that surface when
```

The three `kbbl` hits refer to Anthropic legacy 4.x model IDs; the DBOS hit uses “scopes” as an ordinary English verb. Section 4's audit criterion is: **the audit returns no hits beyond this recorded baseline**.

## Cohort bounds

W2 changes the action-to-attempt join in `oakridge-dbos/src/storage/commit.ts:440-441`. That is the bound for its `canonical(` replacement. These four deep-equality sites are separate behavior and W2 must leave them alone:

| Site | Existing comparison |
| --- | --- |
| `writeDelta` at `commit.ts:377` | Unit status or input changed. |
| `writeDelta` at `commit.ts:387` | Attempt row changed. |
| `writeReviewPrompts` at `commit.ts:501` | Rendered prompts unchanged. |
| `selectChangedWanted` at `commit.ts:532` | Wanted set differs from the last logged set. |

W3's 500-line bound applies to `workflow-core/crates/evaluator` only. At `897dfa68`, `workflow-core/crates/compiler/src/workflow.rs` has 1,029 lines and `workflow-core/crates/compiler/src/expressions.rs` has 969. Both are W5's files and outside W3's bound. Section 4 asserts the repository-wide reading once all nine cohorts merge.

### W3 snapshot write inventory

The closed `Delta` enum in `evaluator/src/apply.rs` follows the writes in the pre-refactor evaluator. `apply` is the only function that changes a snapshot.

| Original write site | Delta variant |
| --- | --- |
| Launch input and run activation; cancellation and root status synchronization | `RunInput`, `RunStatus` |
| Launch root creation and group member materialization | `PushUnit` |
| Candidate input resolution | `UnitInput` |
| Candidate blocking/activation, stage or group completion, empty group completion, cancellation | `UnitStatus` |
| Periodic attempt restart and new pending wanted attempt | `PushAttempt` |
| Worker start/end and failed code validation | `ReplaceAttempt` |
| Publication | `PushRevision` |
| Validator, operator, and engine decisions | `PushDecision` |
| Retry request | `PushRetry` |
| Expression budget charges formerly held in an evaluation `Cell` | `EvaluationBudget` |

The replay digest test frames the JSON bytes of every `StepResult` from all three frozen traces and compares their SHA-256 against the base evaluator. The fixture blobs are unchanged.

`StepEntity` is defined in `workflow-core/crates/model/src/values.rs`, beside the existing `StepError`. The W3 file-scope list named `protocol.rs`, but `values.rs` is the correct file for this change. The host's pre-existing `thread_local RefCell<CoreState>` remains because the synchronous ABI must retain its program cache and response buffer between calls. It is separate from the three removed evaluator budget `Cell`s; a literal search for `Cell` in `src/` will still find `RefCell` in `host.rs`.

W7's e2e clause is: **the development e2e test's assertions are unchanged and pass**. W6 necessarily edits `oakridge-dbos/tests/development-e2e.test.ts`; W7 preserves its post-W6 assertions.

## Frozen replay corpus

The following are git blob hashes at the `epic/core-v2` tip above. Each hash was read with `git rev-parse HEAD:<path>`; fixture regeneration changes the hash and must be visible in a later diff.

| Fixture | Blob hash |
| --- | --- |
| `workflow-core/fixtures/traces/fan-out.json` | `ccbe92818e6a9a97bade8e7a8ead7169396ef1dc` |
| `workflow-core/fixtures/traces/fan-out-stall.json` | `31c753a1f1babebbbd42baf31195d127f96dd05f` |
| `workflow-core/fixtures/traces/review-loop.json` | `e81ccbcf486be61290fad934b564603c4521bc53` |
| `workflow-core/fixtures/bundles/development.json` | `d23dd2a223677771928008c0efda2a361408cb04` |
| `workflow-core/fixtures/bundles/fan-out.json` | `d20e9b2e64633514e4035e41de2de316f67ca646` |
| `workflow-core/fixtures/bundles/r5-cohort.json` | `ac3972b71ea7df9ca9479e79d5551df4c2037531` |
| `workflow-core/fixtures/bundles/review-loop.json` | `28632697edf93bc8153e47c94cfcd5dd15968011` |

“Replay identical” has a cohort-specific meaning:

| Cohort | Required comparison |
| --- | --- |
| W1 and W3 | Byte-identical against the frozen corpus, with no fixture regeneration. |
| W2 | Identical after a named `W2` projection of the changed wire fields. State the projection and its exact paths in the W2 PR body. |
| W6 | Identical after a named `W6` projection of the changed wire fields. State the projection and its exact paths in the W6 PR body. |
| W8 | Identical after a named `W8` projection of the changed wire fields. State the projection and its exact paths in the W8 PR body. |

The intentional wire-shape changes across W2, W6 and W8 concern `wanted`, `RunState`, `UnitStatus` and attempt `ended_at`. Each named projection must cover only its cohort's intentional changes to those fields, compare everything else unchanged, and identify the before/after shape in its PR body. A regenerated fixture alone does not establish replay identity.

## Governing-spec location and tracked-repository gap

The governing specs are present in the main checkout at `/home/steve/codes/rol/oakridge/comms/`:

| Spec | Location |
| --- | --- |
| Part 1 | `/home/steve/codes/rol/oakridge/comms/oakridge-core-spec.md` — **§12, “Decisions,” starts at line 569**. |
| Part 2 | `/home/steve/codes/rol/oakridge/comms/oakridge-core-spec-part2.md`. |
| Rescue | `/home/steve/codes/rol/oakridge/comms/oakridge-core-v2-rescue-spec.md`. |
| Validation | `/home/steve/codes/rol/oakridge/comms/oakridge-core-v2-validation-spec.md`. |

`comms/` is ignored by Git and absent from this cohort worktree, so these files are not part of the tracked repository or available through its branch tip. W2 can read the main checkout paths above before it merges; another environment needs the operator to supply the same specs. Section 1 rule 3 reaches the tracked in-repository documentation surface `workflow-config/README.md` (part 2 §1 and rescue spec R5 at line 3), and these section citations in code:

| In-repository citation | Cited section |
| --- | --- |
| `oakridge-dbos/src/projections/attention.ts:7-8` | Part 1 §12. |
| `oakridge-dbos/src/storage/executor-store.ts:9` | Rescue spec §2.2. |
| `oakridge-dbos/src/projections/schema-view.ts:6` | Rescue spec §2.4. |
| `workflow-core/crates/model/src/values.rs:254,281` | Part 1 §§5.2 and 2.5. |
| `workflow-config/README.md:3` | Part 2 §1 and rescue spec R5. |

**Operator question answered:** Part 1 §12 is at the absolute path above. Because that file is ignored and outside the cohort worktree, a semantic change cannot be recorded there through this PR; W2 must access that path, or an operator-supplied copy in another environment, before its first semantic change merges.
