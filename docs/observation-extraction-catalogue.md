# Observation extraction catalogue

Observation selects an extractor registration by the pinned definition ID, stage
key, artifact key, and resolved schema version. The shared core blocker matches
by artifact key and schema version across definitions and stages. An unregistered
declaration produces one non-retriable `unregistered_declaration` issue and no
items. Registered operational artifacts have no extractors.

Revision identity is the producer, namespace, and the unchanged DBOS revision ID.
Bound links resolve within the frozen input bindings recorded on the delivered
revision. A proposal citation resolves at its exact revision ID and JSON pointer.
Logical task identity includes the run, task kind, and authored local ID within
the producer and namespace.

## Development

| Artifact | Selector | Item kind | Identity or links |
| --- | --- | --- | --- |
| `analysis` | `/requirements/*` | requirement | Requirement task |
| `analysis` | `/requirements/*/findings/*` | finding | Addresses its enclosing requirement |
| `spec` | `/requirements/*` | requirement | Requirement task. Derives from bound analysis findings |
| `plan` | `/cohorts/*/allocations/*` | allocation | Requirement task. Addresses the authored requirement |
| `brief` | `/build_items/*` | build_item | Addresses each named requirement with the brief's repository key |
| `brief` | `/technical_decisions/*` | technical_decision | Addresses the named build items in the brief |
| `assessment` | `/item_assessments/*` | item_assessment | Assesses a bound build item or a requirement task |
| `assessment` | `/additional_findings/*` | additional_finding | Addresses named build items in bound briefs |
| `assessment` | `/proposals/*` | feedback_proposal | Derives from its exact citation when present |
| `assessment` | `/verifications/*` | assignment_verification | Captures the authored verification |
| `blocker` | `/` | blocker | Captures the core blocker body |

Both cohort and integration assessments register their own artifact declaration.
Repository applicability comes from the qualified build-item links. Each
applicable repository lists judgments that assess those build items, or an empty
list when a judgment has yet to arrive.

## Study

| Artifact | Selector | Item kind | Identity or links |
| --- | --- | --- | --- |
| `plan` | `/cases/*` | case | Case task |
| `plan` | `/slice/criteria/*` | criterion | Criterion task |
| `plan` | `/pilot_selection/criteria/*` | criterion | Criterion task in current study definitions |
| `plan` | `/iteration_triggers/*` | trigger | Trigger task |
| `plan` | `/hypotheses/*` | hypothesis | Item addressed by path |
| `plan` | `/outcomes/*` | outcome | Item addressed by path |
| `slice_build` | `/qualifications/*` | qualification | Assesses the named case |
| `expansion` | `/qualifications/*` | qualification | Assesses the named case |
| `slice_report` | `/criteria_marks/*` | criterion_mark | Assesses the named criterion |
| `slice_report` | `/trigger_marks/*` | trigger_mark | Assesses the named trigger |
| `slice_report` | `/paid_results/*` | paid_result | Assesses the named case |
| `slice_assessment` | `/item_assessments/*` | item_assessment | Assesses the task of the authored subject kind and ID |
| `slice_assessment` | `/additional_findings/*` | additional_finding | Addresses each authored related subject |
| `slice_assessment` | `/proposals/*` | feedback_proposal | Derives from its exact citation when present |
| `slice_assessment` | `/verifications/*` | assignment_verification | Captures the authored verification |
| `assessment` | `/item_assessments/*` | item_assessment | Assesses the task of the authored subject kind and ID |
| `assessment` | `/additional_findings/*` | additional_finding | Addresses each authored related subject |
| `assessment` | `/proposals/*` | feedback_proposal | Derives from its exact citation when present |
| `assessment` | `/verifications/*` | assignment_verification | Captures the authored verification |
| `freeze` | `/cohorts/*` | cohort_file | Cohort-file task. Addresses each named case |

The study registers assessments separately for expansion and integration.
Workspace, spend request, pull request, pull request state, observed state, and
manual merge target declarations have empty extractor lists.

## Portability fixture

| Artifact | Selector | Item kind | Identity or links |
| --- | --- | --- | --- |
| `roadmap` | `/folios/*` | folio | Item addressed by path |
| `appraisal` | `/remarks/*` | remark | Item addressed by path |

The browser test publishes a manuscript with no registration and checks that
Observation records an unregistered declaration issue.
