# Observation

`observation/` is the provisional name for an independently deployable service package. A directory rename changes only this directory and the three root workspace entries: `package.json` workspaces, `package.json` typecheck, and `tsconfig.json` references. Its dependency list and types belong to this package; it does not import `oakridge-dbos` or `kbbl`.

Canonical JSON v1 identities are computed from the canonicalized body recovered from JSONB. Byte-identical recovery of a producer's submitted JSON is not claimed.

The service creates its current schema on an empty database and verifies that
schema on restart. It does not upgrade or adopt an older installation. The checked-in
`fixtures/oakridge/run-slice/` corpus drives the cross-layer slice and failure
cases. Run `bun test observation/tests` with a local PostgreSQL server named by
`OAKRIDGE_TEST_DATABASE_URL`; the tests create and remove isolated databases.
They do not contact a model provider or Assay.

## Canonical JSON v1

The canonicalizer emits UTF-8 JSON with no insignificant whitespace. Object keys are sorted by UTF-16 code unit; array order is retained. Strings use JSON string escaping. Finite integers within JavaScript's safe-integer range use the shortest base-10 decimal without an exponent or signed zero. Non-integers use the shortest plain decimal that round-trips within **15 significant decimal digits**, obtained from `toPrecision(15)` by removing trailing zeroes and expanding any exponent. A non-integer that cannot round-trip that representation is refused. NaN, infinity, unsafe integers, undefined, cycles, sparse arrays and non-JSON objects are refused. Digests are SHA-256 over these UTF-8 bytes and carry the tag `canonical-json/v1:<sha256 hex>`.

## Grading contracts

`GET /v1/source-revisions/:revision_id/items?item_path=...` resolves a captured JSON
pointer to its occurrence under a read credential. Use the returned opaque id;
clients must not compute observation digests. Revision ids and occurrence ids must
be URL-encoded. Item jobs use `limit=1..200` (default 50) and nonnegative `offset`,
return `items`, `total`, `limit`, `offset`, and sort by creation time then job id,
oldest first so later inserts do not shift earlier offsets.

`GET /v1/grading-support/v1?run_id=...` is an additive, paginated read. Optional
`question_id` and `question_version` must be supplied together. Each row has
independent `support`, `readiness` and `execution` dimensions, plus captured
`definition_id` and `artifact_schema_version` provenance. Support checks the schema
pin, extractor-selected item kind and implemented recipe; it never gates on the
whole-workflow definition hash. Missing pinned evidence leaves a supported item
unready and visible. A run matching no registered schema pins reports
`no_applicable_question_pins`. The existing `/v1/evaluation-eligibility` decisions
and `human-coverage/v2` coverage counters retain their previous meanings.

Criteria (including plan-wide criteria) are obligations/references. New jobs and
human answers refuse them and the retired `plan.criterion_traceability/v1`,
`brief.source_fidelity/v1`, and `assessment.coverage/v1` questions. Historical
observations retain their original question/version/subject and read back with
`legacy_readback: true`. Item-grade listings carry captured provenance and a
separate `criterion_references` list. For example, two independently graded
assessment findings each have their own `observation.subject_occurrence_id` and
both list the same criterion occurrence in `criterion_references`; the criterion
is never substituted as either grade's subject. A view model preserves that direction:

```json
[
  {"subject_occurrence_id":"finding-one","criterion_references":[{"occurrence_id":"criterion-a"}]},
  {"subject_occurrence_id":"finding-two","criterion_references":[{"occurrence_id":"criterion-a"}]}
]
```

These ids are illustrative opaque identities. An analysis finding's source
schema `{id, description, severity}` provides no criterion reference: it is graded
on its own pinned evidence and contributes to no criterion composite.

No replacement plan/brief claim shape is declared here. Naming real authored
source models and new question identities for those claims is follow-up work;
wrapping criterion text or retargeting a registered question is refused.

## Run metadata and capture

The `observation.source-event/v1` envelope accepts `kind: "run_metadata"` with
`run_id`, `event_id`, `event_kind`, `metadata_version` (producer-declared string),
and `grading_settings: { grading_enabled: boolean }`, alongside the existing
nullable definition/schema provenance. This is separate from `run_input`.
Metadata is stored once per tenant/run, latest delivered cursor wins, in the same
transaction as cursor advancement. A replay reports the existing cursor conflict
and cannot duplicate or overwrite a newer row.

`GET /v1/runs/:run_id/grading-configuration` returns either `state: "declared"`,
the boolean setting and delivery provenance (metadata version, event id, cursor,
definition/schema), or `state: "unknown", grading_enabled: false, provenance: null`.
Neither metadata delivery nor these reads schedule grading. Unknown outcome kinds
become `unmapped` with the original kind as the reason, so the ordered cursor
continues; malformed envelopes still fail with `invalid_event`.

Verify live DBOS capture after deployment with a known reviewed run:

```bash
bun observation/scripts/verify-dbos-capture.ts --run-id <reviewed-run-id>
```

The check requires `OAKRIDGE_OBSERVATION_URL`,
`OAKRIDGE_OBSERVATION_INGEST_TOKEN` and `OBSERVATION_READ_TOKEN`. It authenticates
both capabilities and verifies stored source revisions, occurrences and relations.
Missing credentials or rows fail loudly. The integration test replays the actual
recorded DBOS delivery corpus and verifies those reads in an isolated database;
that test alone does not prove the current deployment is capturing.

## Criterion composite policy v1

`GET /v1/items/:criterion_occurrence_id/criterion-composite/v1?as_of=<ISO timestamp>`
is a read-only derivation over immutable observations, separate from human
coverage. Omit `as_of` for the current instant. Every `CriterionComposite` returns
the run/as-of scope, criterion, policy `explicit-criterion-constituents/v1`, exact
constituent item/revision/stage and observation/question/evaluator identities,
judgment counts, `{measured, expected}` coverage and individual named gaps.
It returns no average, percentage, letter or pass/fail token.

Membership follows explicit producer/human `assesses` or `derived_from` references
to the criterion and its pinned criterion lineage (`derived_from`, `same_as`,
`supersedes`). Inferred links, prose similarity and artifact residence never add
members. The whole run is in scope, including earlier stages. Per logical item
within a stage/artifact kind, the latest referring revision by recorded time,
revision id and occurrence id contributes. Path-only items have no asserted
cross-revision identity and remain distinct. Corrections remove superseded
observations; independent attempts select by recorded time then observation id,
per item/question/version/evaluator. Historical and superseded rows remain
addressable through grade history.

Coverage counts items with at least one selected observation over explicitly
referring items; it does not assert that every registered evaluator has measured
them. Differing judgment values under the same question/version mark disagreement,
including across constituents; unlike questions are never normalized or compared.
Unmeasured, unsupported, unready, pending and failed parts remain visible. No
constituents yields an incomplete result with a coverage gap. Reading or replaying
a composite neither schedules a job nor calls a provider nor writes a grade.

Startup question/evaluator catalogue registration remains blocked on the operator's deployment-pin
decision: `oakridgeQuestions()` requires caller-supplied expectations, and existing
registration requires `expected_definition_id`. This change does not invent a
workflow hash or change its nullability without that decision. Registration
idempotence, immutable redefinition and subject-kind conflicts are tested; the
startup call still needs the approved deployment input. This baseline is for an
empty-database cutover; follow the root database-cutover procedure when deploying.
