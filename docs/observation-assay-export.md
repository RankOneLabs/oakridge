# Frozen Assay export

`POST /v1/exports/assay` creates an explicit, frozen dataset for an Assay handoff. It requires a tenant-scoped observation read bearer credential. The request is JSON; `{}` considers every occurrence in that tenant. A caller can narrow the included records with `selection.run_id` or `selection.occurrence_ids`. The service still records a membership row and an exclusion reason for every candidate it considered.

An optional `target` names the intended consumer and its redaction policy. Raw build output, raw test output, and repository content are withheld by default. Each withheld field has a path and reason in `membership[].redaction_reasons`; explicit `true` values in `target.redaction_policy` allow the corresponding class for that target. For example:

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

The format version is `assay-jsonl/v1`. `membership_digest` is the `canonical-json/v1` digest of the `membership` array sorted by candidate id; it is independent of manifest id, freeze time, file formatting, and JSON key order. A candidate id is the same canonical digest of `[occurrence_id, observation_id]`, with `null` for an occurrence with no grade. The manifest also records the SHA-256 **byte** hash of `candidates.jsonl` in `file_hashes`. A consumer can recompute both hashes from the two files. `revision_digest` is the original source revision body digest; it remains the pinned identity even when the exported snapshot has redacted fields. `evidence_set_digest` covers the evidence references, incomplete flag, and incompleteness reason.

Selection includes complete evidence sets with answered grades. An evidence reference with no captured content is excluded because an offline consumer could not resolve it. Other considered candidates remain in the manifest with reasons such as `run_id_mismatch`, `occurrence_not_selected`, `no_grade_observation`, `incomplete_evidence_set`, `unresolved_evidence_content`, or `answer_abstain`. A short or empty JSONL file can therefore be explained by the manifest. Redaction can thin the content of an included record, and every withheld field is separately named in `redaction_reasons`.

`export_manifest` and `export_membership` are immutable after creation. The service writes the header and membership in one transaction and refuses later updates, deletes, or membership inserts against an already committed manifest. Appending a grade after that transaction does not change a frozen manifest, its files, or its digest. A fresh export has a new manifest id and reflects the new grade. The later purge flow must refuse a run with occurrences referenced by any frozen membership row.
