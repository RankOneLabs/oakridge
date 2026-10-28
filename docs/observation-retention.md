# Observation retention

## Purge trigger

Oakridge's operator-event publisher reads `authority.operator_event` in commit order. For `{ kind: "invalidate", data: { target: "run", run_id } }`, it reads `authority.run` by the event's `run_key` using Oakridge's existing database handle. The scoped ingest delivery carries that read result. The observation service purges only when `run_key` equals `run_id` and the confirming read found no run. An invalidation for a run that still resolves does nothing. Failed delivery leaves the operator cursor unchanged, so the publisher retries.

## Cascade and audit

The single `purgeRun` entry point deletes the run's captured revisions, item occurrences, item relations, extraction issues, evaluation executions and grade observations. It also clears source outcomes, human-grade source rows, collaboration comments, ingest receipts and logical-item identities for that run. Its `purge_event` names the run, trigger event, run key, override flag, frozen manifest IDs and a separate removed-row count for each of the six layers. The check, deletion and audit insert run in one transaction. A failed audit insert rolls the deletion back.

## Frozen export manifests and override

Any occurrence named in a frozen export manifest blocks purge, including an excluded candidate. An operator may explicitly resubmit that operator-event delivery with `operator_override: true` through the scoped ingest endpoint; the normal publisher always sends `false`. The override and affected manifest IDs are recorded on the `purge_event`. Frozen manifest and membership records remain immutable and retain the IDs and digests they pinned, even when the override removes the underlying source rows. The exported comparison can then be explained, but the deleted evidence can no longer be reproduced from the service.

## Archived runs

Archiving is retention, not deletion. Archived runs remain captured and gradeable. Every historical backfill enumerates `authority.run` directly, including rows with `archived_at` set, and reports active and archived counts separately for each source.

## Deletion before delivery

If Oakridge deletes a run before the live adapter reaches it, `deleteRun` removes its `authority.event` rows alongside its artifact revisions, review decisions and collaboration rows. That run never arrives at observation; this is the intended outcome, not an ingest gap. The retained deletion invalidation may still reach the service and produce a zero-count purge audit.

## Access revocation

Access revocation follows deletion's retention terms: remove the affected run's six captured and derived layers, source outcomes and comments; retain the `purge_event` and frozen export manifest metadata; require an explicit, recorded override when a frozen manifest includes an affected occurrence. The cost of overriding is loss of reproducibility for that pinned evidence. No revocation mechanism is built in this pass. A later tenancy and access model must define which runs a revocation affects before it can call the same purge entry point.
