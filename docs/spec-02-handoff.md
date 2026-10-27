# Spec 02 handoff: item addresses and trace links

The producer contract is `workflow-config/development.yaml`, pinned per run. Address an item as `(run_id, artifact_revision_id, item id or JSON path)`. A task uses its `id`; a cohort decision or criterion uses its id within that cohort. An item without an id uses a JSON path within its immutable revision, such as `/risks/0`, `/findings/0/evidence/1`, `/requirements/0/status`, or `/known_issues/0`. For the text `spec` artifact, use a section or span path inside its revision. A stable id names a logical item, not its bytes: deliberate rewording preserves the id, and a genuinely new item gets a new id. Task ids are unique in the run's tasks list; decision and criterion ids are unique within their cohort.

| Producer field | Link target or anchor |
| --- | --- |
| `analysis.proposed_spec_updates[].finding_ids` | Finding ids in that analysis. |
| `tasks.tasks[].requirement_ids` | Requirement ids in the approved analysis. |
| `plan.cohorts[].acceptance_criteria[].task_ids` | Task ids in the reviewed tasks revision. |
| `plan.cohorts[].acceptance_criteria[].decision_ids` | Decision ids in the same plan cohort. |
| Plan criterion id shared with brief criterion id | The brief carries its plan cohort criterion id unchanged, including after text is rewritten. |
| Plan decision id shared with brief decision id | A sourced brief decision carries its plan cohort id; a brief-only decision gets a new id. |
| `brief.approaches_rejected[].decision_ids` | Winning decision ids in the brief cohort. The rejected approach itself has no plan source. |
| `build_result.head_sha` | Repository commit actually built, anchoring changed-file and test claims. |
| `assessment.findings[].criterion_id` | Brief criterion id for a cohort assessment. |
| `assessment.head_sha` | Repository commit assessed; the cohort assessor copies reviewed `build_result.head_sha`. |

An empty id list means **no link**, never “unknown.” Missing links remain unlinked; a consumer must not infer them from prose. Plan-wide `acceptance_criteria` are text with no downstream criterion ids. Integration findings have no brief criteria, so `criterion_id` is unset. A brief-only decision has no plan decision source, and a rejected approach has no upstream plan item. Risks, requirement statuses, finding fields, and known issues are located by JSON path. `assessment_finding.evidence` is a required list; each reference has `kind` (`file`, `test`, or `output`), `ref` (path with optional line range, test id, or command), and optional `detail`.

Artifact revisions are immutable. A revision whose body equals its predecessor's body is a **republication**, not an edit; skip it when pairing before and after for grading. The spec editor publishes only `spec`; after spec approval, the task editor publishes only `tasks`. Each review and revision cycle is independent: a spec revision does not republish tasks, and a tasks revision does not republish spec. The builder publishes build result and PR together; the integrator publishes assessment and PR together.

To pair a `pr` revision with its `build_result`, first use their shared `artifact_revision.by_id` attempt id. An operator edit leaves `by_id` null; in that case walk `predecessor_id` from the edited revision to the nearest predecessor carrying `by_id`, then pair with that attempt's build result. Order candidates by `created_at` when needed. The `artifact_revision.subject` of a cohort assessment identifies the build result it reviewed. These columns are retained in `oakridge-dbos/src/storage/migrations/0001_core.sql`.

Human labels already exist: `authority.review_decision` records approve and request-changes effects, target revision, and feedback payload per revision; `authority.collaboration_thread` anchors comments to an artifact revision, with JSON-pointer anchors in its context. The accompanying messages live in `authority.collaboration_message`. Preserve the revision and pointer when extracting a label; later revisions do not rewrite an earlier label.
