# Fixture provenance

The event IDs, `commit_txid`, timestamps, and revision `by` values in
`events.json`, and the pre-existing decision's ID, transaction ID, timestamp
and event field names in
`operator-decisions.json` were observed in `authority.event` for
`run-38bd8c2fad299e90`. The decision feedback was replaced with harmless
fixture text; its `decision_id` and `effect` are hand-written backfill metadata.
The `launched` input and brief/assessment unit names were
adapted for this test. The assessment's subject is null in the fixture because
its observed build-result revision is outside this slice. Revision event bodies
are copies of the separate revision files so the event payload keeps the
producer's shape while the slice can assert L0 identity against those files.

The three revision bodies are hand-written from the current development
artifact contract. The available run predates producer-explicit criterion IDs:
its plan, brief and assessment rows all lack those IDs. These fixtures add two
shared IDs to exercise the current contract, and retain a bare string plan
criterion and a finding with a null `criterion_id` to cover legacy shapes.
Failure cases derive changed copies of these bodies in the test.
The `failure_cases` object in `events.json` is hand-written test material, not
an `authority.event` row. It pins the duplicate, reorder, conflict, incomplete
evidence, repeated delivery, grader failure and correction inputs used by the
companion suite.
