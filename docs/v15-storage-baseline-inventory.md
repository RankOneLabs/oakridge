# v15 storage baseline supersession inventory

This is the end-to-end union of migrations 0001 through 0022 before they were
replaced. “Final columns” means the shape after all 22 files, including later
renames and drops. The v15 disposition records where each responsibility went.

| Legacy table | Final columns and principal constraints | Final indexes | v15 disposition |
| --- | --- | --- | --- |
| `project` | `id`, `name`, `repo_dir`, `forge_repository`, `base_branch`, `created_at`; PK `id` | PK | Retained as `project`; branch is named `integration_branch`. |
| `workflow_definition` | `id`, `name`, `version>0`, `definition`, `archived`, `created_at`; unique `(name,version)` | PK, unique name/version | Retained. |
| `workflow_run` | `id`, definition/project FKs, `context`, `archived`, `created_at`, `state`, `outcome`, `record_version>=0`, `ended_at`; terminal-shape check | archived | Retained with the six-value core status. `record_version` covers run facts only. |
| `stage_instance` | `id`, run FK, key/type/contract, coordinator workflow ID, timestamps/outcome, nullable legacy attempt root, `state`, `materialization_closed`; legacy and v2 uniqueness | run/stage partial uniqueness | Replaced by a run-owned stage with its own `durable_version`. |
| `run_unit` | IDs, parameters, input snapshot/fingerprint, state/outcome/timestamps, admission and materialization fields; unique stage/unit | run/state | Replaced by `cohort`, including opaque versioned stage data. |
| `run_unit_dependency` | stage/unit/dependency composite keys and same-stage FKs | reverse dependency | Dependency blocking is represented by cohort status and typed blocked reason. |
| `run_stage_scheduling_policy` | stage PK/FK, max parallel, manual admission, fingerprint | PK | Removed; policy interpretation belongs to later stage code. |
| `run_admission_command` | stage/unit, idempotency key/hash, applied time | composite PK | Removed. |
| `work_order` | id/unit FKs, reason, snapshots, state, workflow/idempotency/capability fields, execution request, timestamps | unit/state, unique workflow and request | Replaced by `attempt` plus its deterministic transition effect. |
| `executor_attachment` | work-order PK/FK, executor type, external reference, health, cleanup state, updated time | PK | Replaced by `session`; adapter reference is retained for replay. |
| `run_output_slot` | unit/output/collection identity, type/required/policy, state, artifact/wait/update FKs, invalidation, timestamp, version | scalar and collection identities | Replaced by artifact acceptance and gate-output join rows. |
| `artifact` | revision identity and coordinates, type/body/label, chain/parent, emission keys, attempt/work-order links, lifecycle timestamps and generated effective/history slots | resource revisions, effective revision, chain, lifecycle, work-order emission | Split into `artifact`, `artifact_owner`, `artifact_acceptance`, and discriminated `artifact_provenance`. |
| `artifact_emission_idempotency` | stage/execution/unit/output/collection/key, payload hash, artifact FK, created time | scalar and collection identities | Removed; accepted slot and transition workflow identities are durable. |
| `wait` | stage/unit/artifact, kind/closes-on/status/outcome, execution/command workflows, timestamps, optional v2 unit/output/collection | command, artifact, open scalar/collection slot | Replaced by `wait_gate` plus revision and output-slot sets; a subject set may be empty. |
| `run_transition` | run/unit/work/wait/output/collection links, operation/actor, prior/resulting run versions, detail, created time, global sequence | run order, unit time, sequence | Replaced with owner kind/id, launch reason, owner-local versions, typed effect descriptor, and deterministic DBOS workflow ID. |
| `gate_decision_audit` | run/stage/execution/unit/artifact chain/revision, step/action/comment/feedback, apply/idempotency/create fields | created time, unique idempotency | Gate outcome belongs to `wait_gate`; durable effects belong to `run_transition`. |
| `collaboration_thread` | artifact/revision FKs, anchor, open/resolved status, created time | PK | Replaced by run-scoped `session_message`; artifact thread is optional. |
| `collaboration_message` | thread FK, body, author, created time | created time | Replaced by `session_message` sender/recipient and delivery fields. |
| `review_item` | artifact/revision FKs, anchor/claim/reality, status/resolution, created time | created time | Removed from core storage. |
| `epic_workflow_profile` | run FK, title/slug/lifecycle/final policy, repositories, base branch, timestamps | run unique, updated time | Removed from core storage. |
| `cohort_pull_request_reconciliation` | run/stage/unit/repository identity, observation/mismatch, observed/completed/updated times, handoff artifact | run | External evidence becomes an artifact or session message. |
| `final_pull_request_reconciliation` | profile/repository key, observation/mismatch, observed/merge/confirmation/comment times and key | partial confirmation key | Removed from core storage. |
| `runtime_secret` | name, value, created time | PK | Retained for runtime-owned secrets. |

Three intermediate tables were already removed by migration 0019 and therefore
do not exist in the final legacy schema: `workflow_attempt` (root workflow/run,
fork parent, outcome and timestamps), `executor_projection` (execution and
terminal projection), and `command_outbox` (typed command, target workflow,
payload, sequence, retry/claim/delivery fields and pending/delivered indexes).
The v15 baseline does not restore the command outbox. Each transition is the
single effect record and carries its DBOS workflow identity.

The baseline also adds concepts the chain could not represent: `cohort`,
`attempt`, `session`, artifact link tables, set-valued gates, and
`session_message`. Composite foreign keys enforce same-run and same-stage
relationships; partial uniqueness on `session.kbbl_session_id` allows a started
attempt to exist before kbbl has ensured its session.
