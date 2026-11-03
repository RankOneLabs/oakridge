# Fixture provenance

These files derive from the isolated committed-development run `run-5ca31bc6c2414610`,
definition `d8a33d159bf8bdc6e8bad5ca31709fa857a55468ee8c0734fb173cd5b9791b28`. The durable production capture is
`observation/verification/a670bcfbaa3045bc8d4415ac29222b73/capture.json`; its adjacent authority-rows.json retains the original event rows.

Before regeneration, the exact capture digest `canonical-json/v1:8112cddd9f077c08fe29e4eaf99fd72e106e916aebd9886b7393207f6128c9d2` was graded
through the direct TypeSafe adapter using plan.criterion_traceability. Execution
`9bdc9b8d-9c7b-4065-b663-7b35a56adae6` and all admission/result records were read back from
authenticated HTTP response bodies; the adjacent grade.json retains the evidence.

The revision files are verbatim published plan, brief and assessment bodies.
events.json selects the actual launch, those revision events and plan approval;
captures retains their original observation.artifact-revision/v2 envelopes,
definition IDs and artifact schema versions. IDs, transaction IDs, timestamps,
writer IDs, predecessors, subjects and decision metadata are unchanged.

The source run input and automatic acceptance feedback are authored verification
inputs. The nine-case failure_cases block is hand-written test material, never
an authority.event row: duplicate_item, reordered_criterion_ids, revision_update,
missing_source_ref, conflicting_duplicate, incomplete_evidence, repeated_delivery,
grader_failure, human_correction. Its criterion/event references are re-derived
from the new capture; its adversarial text and simulated failure values remain
hand-written. Companion tests derive mutated copies only for those cases.
