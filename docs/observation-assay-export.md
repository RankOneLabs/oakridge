# Frozen Assay export

`POST /v1/exports/assay` creates an explicit, frozen dataset for an Assay handoff. A tenant-scoped observation read bearer credential can request the default redacted export. The request is JSON; `{}` considers every occurrence in that tenant. A caller can narrow the included records with `selection.run_id` or `selection.occurrence_ids`. The service still records a membership row and an exclusion reason for every candidate it considered.

An optional `target` names the intended consumer and its redaction policy. Raw build output, raw test output, and repository content are withheld by default. Each withheld field has a path and reason in `membership[].redaction_reasons`. Any `true` allowance in `target.redaction_policy` requires a separate tenant-bound token configured through `OBSERVATION_EXPORT_RAW_CREDENTIALS`; a read token alone receives HTTP 403. Tokens are unique across ingest, read, grade and raw-export capabilities. For example:

```json
{
  "selection": { "run_id": "run-123" },
  "target": {
    "name": "assay-local",
    "redaction_policy": {
      "allow_raw_build_output": false,
      "allow_raw_test_output": false,
      "allow_repository_content": false
    }
  }
}
```

The `201` response gives the manifest and paths to `manifest.json` and `candidates.jsonl`. Files are written under `OBSERVATION_EXPORT_ROOT/<manifest_id>/`, or a temporary directory root when the environment variable is unset. The caller must copy **both** files as one dataset. `candidates.jsonl` has one JSON object for each included candidate. Each line carries its candidate id, source revision, item occurrence, evidence set, grade observation, execution, evaluator, and question snapshots. Those snapshots let a consumer interpret the answer without an Oakridge process, a mutable HEAD read, or an observation-service query. `manifest.json` includes all candidates, including excluded ones, with a disposition and a reason.

The build-result field classifications start from `build_body` and `test_evidence` in `workflow-config/development.yaml`, with explicit classifications for legacy content fields. An unclassified top-level build-result field or selected value is withheld as `unclassified_content`, regardless of its name or the three raw-content allowances. Evidence references may declare `kind` as `raw_build_output`, `raw_test_output`, `repository_content`, or `public`; content with no recognized kind is likewise withheld as `unclassified_content`. The capture envelope does not yet declare sensitivity kinds for other artifact bodies, which continue to use the existing field-name redaction rules.

The format version is `assay-jsonl/v1`. `membership_digest` is the `canonical-json/v1` digest of the `membership` array sorted by candidate id; it is independent of manifest id, freeze time, file formatting, and JSON key order. A candidate id is the same canonical digest of `[occurrence_id, observation_id]`, with `null` for an occurrence with no grade. The manifest also records the SHA-256 **byte** hash of `candidates.jsonl` in `file_hashes`. A consumer can recompute both hashes from the two files. `revision_digest` is the original source revision body digest; it remains the pinned identity even when the exported snapshot has redacted fields. `evidence_set_digest` covers the evidence references, incomplete flag, and incompleteness reason.

To verify a redacted export offline, recompute `membership_digest` from the manifest membership, hash the exact `candidates.jsonl` bytes and compare `file_hashes`, then match each included record's candidate id, occurrence id, revision id, evidence set id and observation id to its membership row. Check that `source_revision.body_digest` equals the pinned `revision_digest`. The original `revision_digest` cannot be recomputed from a record with a redaction under `/source_revision/body`; likewise, `evidence_set_digest` cannot be recomputed when `/evidence_set/evidence_refs` was redacted. When those paths are unredacted, recompute their `canonical-json/v1` digests from `source_revision.body` and `{ evidence_refs, is_incomplete, incompleteness_reason }`, respectively. Verification of the original content of redacted paths requires the original captured artifact or a separately authorized unredacted export; the redacted file alone cannot prove those source digests.

Selection includes complete evidence sets with answered grades. An evidence reference with no captured content is excluded because an offline consumer could not resolve it. Other considered candidates remain in the manifest with reasons such as `run_id_mismatch`, `occurrence_not_selected`, `no_grade_observation`, `incomplete_evidence_set`, `unresolved_evidence_content`, or `answer_abstain`. A short or empty JSONL file can therefore be explained by the manifest. Redaction can thin the content of an included record, and every withheld field is separately named in `redaction_reasons`.

`export_manifest` and `export_membership` are immutable after creation. The service writes the header and membership in one transaction and refuses later updates, deletes, or membership inserts against an already committed manifest. Appending a grade after that transaction does not change a frozen manifest, its files, or its digest. A fresh export has a new manifest id and reflects the new grade. The later purge flow must refuse a run with occurrences referenced by any frozen membership row.

For the Langfuse pilot, `observation/src/langfuse/population-manifest.ts` freezes
the selected occurrence, question/version, evidence digest, stratum and explicit
selection reason before grading. Its full membership digest includes those
fields. `shared_item_evidence_digest` is a second canonical digest of the
sorted, distinct included `{occurrence_id, evidence_set_digest}` pairs. The
pilot runner calls the existing `POST /v1/exports/assay` route and recomputes
that same digest from its frozen manifest; a mismatch is recorded as a failed
population check. The Assay `membership_digest` cannot equal the pilot's full
membership digest because Assay members are grade-specific candidates with
revision and redaction fields, whereas the pilot manifest also pins question,
stratum and selection reason.

The runner semantics differ: Langfuse projection targets a selected
occurrence/question/attempt and its scores can arrive asynchronously, while
Assay exports only answered grades with complete, resolvable evidence as
included candidates. An unanswered, failed or abstaining attempt remains in
the pilot report denominator but appears as an excluded Assay membership row.
Multiple grade attempts can also create several Assay candidates for one
occurrence. The shared digest removes identical item/evidence pairs when
comparing populations, while each format retains its own attempt-level detail.
The Assay manifest remains the controlled-study boundary; the Langfuse score
view alone does not freeze runner or score semantics.
