# Oakridge core replacement specification

Status: implementation specification for a complete replacement of the workflow core and its authoritative storage model. Implementation has not begun. This document supersedes the architectural and implementation choices in `oakridge-workflow-refactor-spec.md` and the fixed runtime model in the v15 contracts. The v15 documents remain evidence of the development workflow's intended behavior, to be expressed as configuration for the new engine.

Review baseline: the complete repository at `epic/schema-refact`, commit `487beef203ab42dcd30c9670bb3c803569cff257`. Paths in the removal inventory refer to that snapshot, including files unchanged by the branch.

## 1. Objective and scope

Replace the core; do not extend, wrap, or incrementally generalize the existing fixed workflow interpreter. The replacement must satisfy both requirements:

1. Configuration defines workflow structure and business progression: scopes, state variants, workers, actions, inputs, publications, review commands, child creation, exposed outcomes, prerequisites, concurrency, failure propagation, and cancellation policy.
2. Each current workflow fact has one authoritative representation in PostgreSQL. All workflow changes pass through one transactional commit boundary. Other stores contain execution records, immutable history, blobs, or rebuildable projections, with explicit ownership contracts.

The rewrite includes the definition language, compiler, evaluator, domain types, workflow schema, state mutation boundary, materialization, durable effect recovery, public workflow API, and workflow-specific operator UI logic. It removes the old implementation and competing decision paths. Reusing transport, database connections, authentication, Git operations, ACP support, and generic presentation components is permitted only after removing their progression responsibilities.

This is not a rewrite of PostgreSQL, DBOS, ACP, React, Git, or every unrelated feature in the repository. It is not a rename of the current core. Successful execution of the existing six-stage example alone is insufficient.

### Non-negotiable proof

The same built engine must run definitions with one, five, six, and seven top-level children, different worker compositions, renamed private states, new operator command names, and different sibling failure policies. Adding these workflows must change only configuration, schemas declared by that configuration, and prompt content. It must not change engine source, adapter source, generated engine enums, or database migrations.

Implementing a genuinely new external operation may require adapter code. Changing when an existing operation runs or what its result means must not.

## 2. Rust decision and execution boundary

Use Rust for the definition compiler, schema checker, pure evaluator, action binding, generic collection validation, and decision explanation. Use Bun for HTTP, PostgreSQL transactions, DBOS scheduling, external adapters, and the operator surface. Keep PostgreSQL as workflow authority and DBOS as durable scheduling infrastructure.

This follows the original workflow design's proposed pure Rust core. Rust enums and exhaustive matching help enforce the interpreter's own constructs; they do not prove the correctness of dynamically supplied workflow definitions. The workflow compiler must check those definitions independently. See the primary references for [Rust matching](https://doc.rust-lang.org/stable/book/ch06-02-match.html) and [Serde tagged enum representation](https://serde.rs/enum-representations.html).

### Package layout

```text
workflow-core/                 Rust Cargo workspace
  crates/model/                branded IDs, type language, checked values, wire contracts
  crates/compiler/             source definition -> checked program or diagnostics
  crates/evaluator/            checked program + snapshot + trigger -> decision
  crates/cli/                  local stdio transport; no workflow behavior
  fixtures/                    valid/invalid definition corpus and expected semantics

oakridge-dbos/src/
  core-client/                 generated wire decoders and bounded Rust process client
  storage/                     new schema, snapshot reader, single commit boundary
  effects/                     durable dispatch, reconciliation, adapter interfaces
  http/                        generic command/publication/query endpoints
  projections/                 read-only operator views

workflow-config/
  definitions/                 example workflows; development flow is one example
  schemas/                     reusable source schemas bundled into definitions
  prompts/                     referenced content, with no mandatory workflow directory
```

The Rust library has no database, network, filesystem, clock, random-number, or process access. Its functions return named `Result` types. The CLI owns stdin/stdout IO and converts failures into protocol errors. External content and implementation capability manifests are supplied explicitly to compilation. Time and observed external facts are supplied explicitly to evaluation.

Start with a persistent local subprocess using newline-delimited, versioned JSON messages. There is no new network service or unsafe FFI. Each request and response has a request ID, protocol version, tagged operation, and typed payload. Supported operations are `compile`, `validate_payload`, `evaluate`, `materialize`, and `explain`. Output is bounded; stdout contains protocol messages only, stderr contains diagnostics. Process death, malformed output, excess output, and timeout produce typed transport failures, never workflow transitions.

The transport supports concurrent callers through a bounded request queue and explicit correlation. Pure requests may be repeated after process replacement. Compiled-program caches are disposable. Rust keeps no execution state that must survive a restart.

Rust is justified here by a small, stable semantic core with substantial type checking. Keep that boundary small. If the implementation starts moving HTTP, database transactions, provider supervision or the whole UI into Rust, it has exceeded this rewrite. The principal added cost is a second toolchain and a checked cross-language protocol; build and integration tests must cover that cost explicitly.

Generate and check TypeScript wire contracts from the Rust protocol model during the build; consumers do not independently maintain copies. Configuration values are decoded against the checked program's named schemas. `serde_json::Value` and TypeScript `unknown` are permitted only at decoding boundaries, not as the domain model handed between transforms. Dynamic records use a named schema and a checked value representation; they are not casts into workflow-specific Rust or TypeScript types.

Use a small explicit dependency set for serialization and content hashing; pin Cargo dependencies and toolchain in the repository. Do not introduce a workflow framework, expression scripting engine, or asynchronous Rust runtime for this pure library.

## 3. Model before implementation

The source of the model is this language contract, the replacement database schema, the actual ACP and adapter contracts, and the development-flow behavioral fixtures. Define these named types before implementing repositories or handlers.

| Type | Responsibility |
| --- | --- |
| `DefinitionBundle` | Source definition plus all referenced schemas, prompts, presentation metadata, and operation contract pins |
| `CheckedProgram` | Resolved and type-checked immutable definition; compiler and language versions included |
| `ScopeDefinition` | One local decision flow with typed inputs, state, events, outputs, child declarations, actions, and exposed outcome |
| `ScopeInstance` | One instance of a scope; configuration reference, immutable inputs, version, and local state |
| `StateSchema` | Finite named variants with typed payloads; workflow variant names are data |
| `OutcomeSchema` | Typed variants exported by a completed scope; no private child state |
| `CommandDefinition` | Operator event schema, availability, exact targets, labels, consequences, and feedback fields |
| `WorkerDefinition` | Execution provider, input contract, output slots, authorization, and action definitions |
| `ActionDefinition` | A typed invocation of an operation/provider with bound inputs and referenced prompt |
| `ArtifactRevision` | Immutable typed content, content hash, provenance, and versioned relationships |
| `OutputSlot` | Sole current revision pointer for a declared scope/worker output and collection key |
| `ExecutionSelection` | Sole current execution pointer for an owner and worker; generation fences old publications |
| `ExecutionRecord` | Immutable selected invocation and identity, plus observed external binding; not worker acceptance |
| `Fact` | Authorized immutable input, result, or observation with source identity and causal references |
| `Decision` | Matched rule, complete read set, typed mutations, and durable effects |
| `EffectIntent` | A durable start, stop, operation, or observation request and its delivery/recovery lifecycle |
| `Receipt` | Idempotent ingress identity, request digest, and committed result |
| `CapacityPool` | Configured generic capacity and authoritative reservations |

All identifiers are nominal types. Grammar constructs and operational result kinds are Rust enums. Workflow stage names, worker names, review commands, private states, and outcome variants are not engine enums.

Scopes replace mandatory run/stage/cohort-specific decision engines. A root, a stage, and a cohort are instances of the same scope model. A worker is a declared action producer within its owning scope. Their UI labels may differ; their progression semantics do not require different interpreters.

## 4. Configuration language

### 4.1 Bundle and type system

A bundle declares `language_version`, workflow key and version, root scope, named schemas, scope definitions, worker/action definitions, presentation metadata, prompt references, and operation contract requirements. All referenced source files are bundled before persistence. Unknown fields fail compilation. Duplicate keys must be detected during parsing, before a JSON parser can silently overwrite them.

The initial type language supports booleans, bounded integers, strings with declared constraints, finite enums, records with named required/optional fields, lists, explicit optional values, tagged unions, and branded references to instances, executions, artifact revisions, and resources. Record fields are closed unless the schema explicitly declares a typed dictionary. Recursive value schemas are out of scope for language version 1 and are rejected, rather than partially interpreted.

Source schema imports are resolved into the bundle. Adding a payload schema using supported constructs is configuration work. Core types remain typed generic values checked against schema IDs; there is no generated engine build per workflow.

Prompt count and directory are unrestricted except for repository containment, declared content availability, and resource limits. Multiple actions may reference one prompt. Prompt input fields are statically checked. Prompt content, referenced artifact revisions, invocation settings, authorization, and operation contract version are frozen with a selected execution.

### 4.2 Scope definition

Each scope declares:

- Typed immutable input ports and explicitly imported contracts.
- Finite local state variants, an initial variant, and payload schema per variant.
- Typed operator commands and accepted facts/results.
- Output slots and artifact schema references.
- Worker/action declarations and publication permissions.
- Static child declarations or dynamic child templates.
- Declared child exports and a terminal outcome contract.
- Decision tree, generic capacity pools, and explicit cancellation handling.
- Presentation metadata and optional viewer identifiers with generic fallbacks.

A parent reads only declared child exports: public observations/progress, output references where explicitly exported, and completed outcome payloads. It cannot read a child's private state, worker acceptance, or private review fields. Child inputs are bound at creation. Ancestor context is available only through declared inputs/imports, not unrestricted path traversal.

### 4.3 Expressions and bindings

Expressions are a finite AST, not source strings or arbitrary callbacks. Initial constructs are typed literals, declared references, field selection, tagged-union construction, record/list construction, equality, finite variant tests, optional-value matches, boolean combinations, and finite list transforms/quantifiers.

References have a declared root and a checked field path. Available roots are local input, local state, current trigger, declared output slot, declared execution result, resource observation, and imported child contract. There is no list of source strings such as `inputs.repository` or special nullability test based on a substring.

Optional and union values must be narrowed by a match before their fields can be used. Binding to a required field from an optional source fails compilation unless every path establishes presence. Equality and assignment require compatible schema/brand types. List transforms are bounded by configured resource limits and cannot perform IO.

### 4.4 Decisions

The decision language contains:

| Construct | Semantics |
| --- | --- |
| `match` | Exhaustive dispatch over a declared state, event, optional, or outcome variant |
| `if` | Two branches over a checked boolean expression |
| `apply` | One atomic set of mutations and selected actions |
| `wait` | No mutation; names the declared event/observation that can resume work and an explanation |
| `reject` | Rejects the current command/fact with a typed reason; no partial mutations |

`apply` may set local state, publish a declared export, select an execution, create/activate children, acquire/release capacity, select observation/operation work, revoke publication authority, request a stop, or complete the scope with a declared outcome. These are generic language constructs. Domain-specific changes such as `capture_accepted_build` are removed; the development flow stores a typed accepted-build revision reference in its configured local state.

Mutation bindings read the pre-decision snapshot. A leaf cannot write the same owned field twice or select incompatible actions for one exclusive worker/resource. The compiler rejects contradictory leaves. There is no ordered list of competing rules with accidental first-match behavior: the tree selects one leaf. Explanations contain bundle hash, scope ID, decision node ID, read versions, trigger identity, and the selected changes/effects.

An event is interpreted against the committed owner state. Unavailable commands are rejected. No handler infers a missing business transition from an execution result. An automatic trigger is part of the declared event vocabulary; automatic changes evaluate until quiescence. Repeating a mutation-free leaf is a wait, not another commit. A bounded evaluation budget prevents runaway internal cycles and reports an engine fault without marking the workflow failed.

### 4.5 Source syntax and required semantic contracts

The version-1 source is strict JSON. IDs are strings at the serialization boundary and resolve to nominal symbol IDs during compilation. Named declarations are arrays of `{key, ...}` records, so duplicate symbols can be diagnosed without depending on object-key overwrite behavior. Tree cases are arrays of `{variant, node}` entries with an optional explicit `otherwise`; duplicate cases fail. `otherwise` is intentional coverage, not implicit waiting. All constructors carry a `kind` discriminator.

The compiler implementation must publish the following closed source contracts in its first milestone, including a machine-readable schema and fixtures. Field spelling can be finalized there; the ownership and semantics below cannot be deferred to handlers or adapters.

| Source contract | Required contents |
| --- | --- |
| Bundle | Language version, key/version, root scope key, named schemas/scopes, referenced prompt contents, presentation, operation requirements |
| Scope | Input schema, state schema and initial value, declared fact/command schemas, exports/outcome schema, outputs, workers/actions, child templates, capacity, cancellation handling, tree |
| Command | Key, payload schema, state availability, target bindings, label/consequence and field presentation |
| Action | Key, operation/provider and contract version, input schema/bindings, prompt reference if needed, authorized outputs and invocation/recovery settings |
| Output | Key, payload schema, cardinality/collection key, publication revision policy and authorized producers |
| Child | Key/template, scope reference, input bindings, dependencies, exposed contracts, collection membership rules |
| Match | Typed value expression, explicit variant cases and optional fallback |
| Apply | Named node ID, nonconflicting mutations, bound selected operations, optional terminal outcome |
| Wait | Named node ID, declared continuation identities, reason and attention metadata |
| Reject | Named node ID, declared error kind and typed details |

Small semantic example: a `document_review` scope may have private states `draft_ready` and `revising`, commands `publish_document` and `ask_for_edits`, and outcomes `released` and `withdrawn`. Its parent depends on `released`; it knows nothing about `draft_ready`. Another definition may rename all five business symbols while using the same constructs. No Rust match arm, SQL check, provider role, or UI command enum is added for those symbols.

An internal checked reference identifies its root, resolved symbol, field selectors and resulting schema ID. `CheckedValue` distinguishes scalar, record, list, variant and branded reference values, and carries its resolved schema. A checked record is not an unconstrained `Map<String, Value>`; construction and access use the schema's resolved field IDs. Source parsing and validation may handle arbitrary JSON; evaluation never assumes raw JSON has a known domain shape.

### 4.6 Hierarchy, collections, and policy

Top-level stage count and names are configuration data. Static children use declared dependency edges. Dynamic children use a typed source collection and a child template with explicit key, input, and dependency bindings.

Materialization validates the entire collection before committing any instance: unique legal keys, valid typed inputs, valid dependency references, acyclic activation prerequisites, and configured cardinality constraints. Empty collections have an explicit policy (`reject` or `complete` with a declared outcome). Collection membership and input revision references become immutable after activation. Revision loops within a scope are separate from activation prerequisite graphs.

Capacity is a configured positive integer on a pool; there is no hardcoded four-slot array or database bound. The definition declares reservation acquisition/release points. The development workflow holds implementation capacity through execution, interruption, review, and awaiting merge, releasing on terminal completion/cancellation. Definitions with limits 1, 4, and 8 must run unchanged through the engine. Reservations are atomic and cannot be oversubscribed by concurrent decisions.

Parent handling of child outcomes is an explicit tree. One definition may cancel unfinished siblings on failure; another may continue independent siblings and aggregate failures. The core must implement both without a policy switch named after either workflow. Completeness/aggregation uses declared outcomes and exports, not a built-in rule that all children must have status `complete`.

## 5. Compiler requirements

Compilation performs decoding, source resolution, schema resolution, visibility checking, expression typing, action binding, graph checking, finite control-flow analysis, capability checking, and canonical bundle construction. Failed compilation returns diagnostics with operation, source path, scope/action/node, expected contract, and actual contract. Nothing is stored as executable configuration on failure.

Reject at least:

1. Missing/duplicate symbols, unknown constructs, unsupported versions, and unresolved content.
2. Invalid schemas, incompatible ports, wrong reference brands, missing required bindings, and unguarded nullable values.
3. Private-state reads across scope boundaries and event/command references not declared for that scope.
4. Non-exhaustive finite matches, missing fallback semantics, conflicting writes, invalid state/outcome assignments, and duplicate exclusive launches.
5. Cyclic static prerequisites and invalid dynamic template mappings.
6. Structurally unreachable declared states/actions/outcomes and nonterminal control-flow regions with no declared continuation or route to an outcome.
7. Required commands that have no handling path and commands declared as available in states where they can only fall into an unrelated generic rejection.
8. Unsupported provider settings, unavailable pinned operation versions, and unhonorable tool authorization.
9. Output/revision policies and presentation features without defined execution semantics.

Control-flow analysis is finite over declared state/event variants. It records conditional edges conservatively and detects structural reachability and closed internal cycles. It does not claim to prove arbitrary payload predicates, external service liveness, agent correctness, or human approval. Diagnostics and tests distinguish structural proofs from runtime obligations. An unconditional initial wait with no continuation/outcome path is invalid; an explicit wait for a declared external event with a checked continuation is valid.

Every accepted field must appear in a compiler/evaluator/provider semantic contract and have behavior coverage. There is no permissive storage of a field that is rejected only after launching a run.

Canonicalization and hashing are defined once in Rust, including definition, schemas, prompts, presentation, provider requirements, and operation contract pins. Store source and checked bundle hashes. Same key/version with different content is rejected. Existing runs pin the checked bundle, language/evaluator semantic version, and operation requirements. A provider implementation upgrade must preserve its pinned contract or old execution must refuse to dispatch with a typed compatibility error; it cannot silently reinterpret the run.

## 6. One authoritative state model

### 6.1 Logical schema

Use a new PostgreSQL schema namespace for the replacement. Do not adapt the existing stage/cohort tables into a second engine model. Define SQL constraints, named Rust/TypeScript records, and generated wire contracts together before feature code.

| Relation | Authoritative fact |
| --- | --- |
| `definition_bundle` | Immutable checked configuration and content pins |
| `run` | Definition pin, root instance reference, creation/archive/deletion metadata; no copied workflow status |
| `scope_instance` | Parent/template identity, immutable typed inputs, current local state, version, and immutable terminal outcome when present |
| `scope_export` | Current explicitly exported value, versioned with its owner; private state never duplicated as an export |
| `child_collection` | Frozen membership/dependency identity and a version used for conflict checking |
| `execution_selection` | Current execution/generation per scope and worker |
| `execution` | Frozen invocation, stable operation key, provider binding and externally observed execution facts |
| `artifact_revision` | Immutable body, schema/bundle reference, lineage and provenance |
| `output_slot` | Current artifact revision per owner/worker/output/collection member |
| `fact` | Immutable accepted trigger, publication/result, or resource observation |
| `transition` | Immutable audit of committed decision, read set, changes, and causal facts |
| `ingress_receipt` | Unique request identity and digest, committed response/result |
| `effect_intent` | Durable effect payload, transport lifecycle, retry schedule and acknowledgement |
| `capacity_pool` / `capacity_reservation` | Configured limit/version and current reservation ownership |
| `resource_binding` | Durable identity and observed evidence for a repository, worktree, PR, or another external resource |

There is no independent stored `cohort.status` alongside local state, no artifact acceptance flag duplicated on an output, and no worker acceptance copied from an artifact. Generic attention/status labels are named projections of these records.

An outcome is a terminal exported contract, not a second mutable local status. Once stored it is immutable, and the instance accepts no further business transitions. Private local state records the final local context; the outcome defines what the parent consumes. Storage enforces the terminal invariant, not a workflow-specific mapping between state names and outcomes.

### 6.2 Review and artifact semantics

Artifacts contain immutable content and provenance. Review is a typed event interpreted by the owning scope. The current approval/feedback decision is represented once in that scope's configured local state, identifying exact revision references or an output-set identity. The artifact body and output slot do not also store acceptance flags. Review history is retained through facts and transitions.

An approval of revision R remains historical evidence when R+1 is published; it does not approve R+1. A generic validity projection compares the configured review target to the current output revision. The configured rule decides whether to clear acceptance, ask for new review, retain an explicitly unchanged revision, or invalidate dependent assessment. The engine does not guess that policy from artifact type names.

Support two declared publication policies with precise semantics:

- `append_revision`: stable artifact chain, immutable successor revision, atomic slot pointer update, expected predecessor required.
- `replace_artifact`: new artifact chain and atomic slot replacement, historical chain retained.

Publication replay with the same ingress identity and digest returns the original committed revision reference. A changed payload under the same identity is a conflict. A fenced execution cannot create a new publication. An exact already-committed publication may be replayed after fencing without acquiring fresh publication authority. Byte-identical content under a different request ID follows the declared publication contract; it is not assumed to be a duplicate action.

Accepted-build copies become typed references to immutable artifact revisions and resource observations. Store a genuinely necessary historical external observation once and refer to it; do not copy mutable PR/head fields into independently updated records.

### 6.3 State in other processes

kbbl's SQLite ACP ledger remains authoritative for adapter-local sessions/turns and process observations. It does not decide workflow acceptance, retry eligibility, stage completion, or parent failure. Oakridge records observations of that ledger with explicit source identities; they are observed facts, not competing copies of business state. Adapter operations use stable idempotency keys and expose start/attach, observe, stop, and capabilities.

DBOS records scheduling/delivery, not application progression. React caches and projection caches are disposable. Files hold immutable artifact blobs/log exports and external worktrees, not current acceptance or workflow liveness. An in-memory map may optimize access but cannot be the only source of a decision or deletion guard.

## 7. Single mutation boundary and concurrency

Use one application mutation service for scope state, outputs, executions, resource observations, collection membership, and capacity. Repositories expose reads and that commit boundary; handlers, adapters, observers, and preparation helpers cannot issue independent domain updates.

The pipeline is:

```text
decode/authenticate ingress
  -> read transaction-consistent snapshot and pending trigger
  -> Rust validate/evaluate/materialize
  -> commit decision with full expected read versions
  -> dispatch durable effects
  -> accept results as new typed facts
```

The evaluator runs outside database locks. The snapshot is read consistently, and its read set includes owner state, mutable output/execution selections, imported exports, resource observations, child collection membership, and capacity pools. A commit locks all mutated/validated owners in stable ID order and checks the full read set. Checking only the receiving scope version is insufficient. Every mutation to a decision-visible relation increments its owning version in this boundary, including preparation evidence.

The minimum named pipeline contracts are:

```text
CompileRequest { source_bundle, available_operation_manifests }
CompileResult = Compiled { checked_bundle, digest, analysis }
              | Invalid { diagnostics }

EvaluationInput { checked_bundle_digest, owner, snapshot, trigger }
EvaluationResult = Apply { decision }
                 | Wait { explanation, continuations }
                 | Reject { error, explanation }

Decision { owner, bundle_digest, node_id, trigger_id,
           read_set, mutations, effect_selections, explanation }
CommitRequest { decision, ingress_identity, ingress_digest }
CommitResult = Committed { receipt, resulting_versions }
             | Replayed { receipt }
             | Conflict { changed_references }
             | Rejected { error }
```

Every field has a named type derived from the checked language or replacement schema. `read_set` entries identify entity/collection/pool and expected version, including absence/membership checks. A commit does not reinterpret tree semantics in TypeScript; it validates and applies the generic mutations produced by Rust. The storage validator enforces ownership, referential integrity, publication authority and transactional constraints even if a protocol message is malformed. It cannot trust unchecked arbitrary mutations just because their sender is the core subprocess.

One transaction validates receipts and versions, writes local changes, output pointers, generation revocation, capacity reservations, facts/transitions, and durable effect/wake intents. Either all commit or none do. Automatic conflicts reload and reevaluate; an operator version/target conflict returns a rejection and refresh context, not a silently retargeted decision.

Ingress identity is unique within run/scope and has a canonical request digest. Duplicate requests return the committed receipt before attempting new evaluation, including after the owner becomes terminal. Identical IDs with different content fail explicitly. No externally visible success is returned until the mutation is durable. Accepted-but-not-yet-interpreted work is reported as pending with a receipt identity, not as a final business decision.

Wakes are hints. Commit durable notification intent and recover missed notifications from PostgreSQL. Duplicate wake delivery cannot select duplicate actions. Parent reevaluation depends on exported-contract changes and terminal outcomes, not access to child internals.

## 8. Execution, recovery, and external resources

### 8.1 Stable execution and delivery

Selecting work creates a new immutable invocation and execution identity in the decision transaction. Deliberate revision/retry selects a new identity. Uncertain delivery repeats the old identity and identical invocation. Rendering prompts and discovering a PR must not change the request while reusing its operation key.

Required repository preparation and PR discovery are separate declared operations/observations. Their durable results are input facts used before selecting agent work. There is no dispatch-time workflow-specific enrichment that changes a pinned prompt on replay.

Providers return a tagged result distinguishing acknowledged success, permanent rejection, transient unavailability, and uncertain acknowledgement. Transport retries do not become worker interruption. A definite failed execution becomes a fact; the configured scope decides whether to retry, interrupt, fail, or ask an operator.

Transient retries use configured deadlines, attempt budgets, and exponential backoff with bounded jitter recorded at the IO boundary. Budget exhaustion emits a typed fact for configured handling. Application deadlines bound connection and response-body reads, Git subprocesses, adapter start/observe/stop, discovery, and projection calls. Exceeding a deadline releases dispatch ownership and schedules recovery; it must not block unrelated owners.

Dispatch uses leases with expiry and fencing. A persisted in-flight intent can be reclaimed after a dispatcher dies. Workers with different owners execute independently through bounded concurrency; one stalled provider cannot monopolize the global sweep. Enqueued DBOS work and periodic database scans use the same intent identities and reconciliation path.

### 8.2 Cancellation and deletion

Publication revocation and confirmed process termination are separate facts. Do not use `fenced_at` as proof that a process stopped.

Cancellation is a typed command handled by the scope's configured cancellation policy. Every definition must declare how cancellation propagates and what outcome it exposes. In the transaction selecting cancellation:

1. Revoke new dispatch/publication authority for affected selections.
2. Persist stop/reconciliation intents for every possibly live external execution, including uncertain starts with no returned session ID.
3. Apply configured child cancellation/outcome changes.
4. Retain execution/resource identities until cleanup is acknowledged.

A known session can be stopped directly. An uncertain start must be resolved by provider lookup/attach-or-cancel using the original key. A provider implementing a resumable reservation must allow cancellation to tombstone the key so a later delayed start cannot launch work. If a provider cannot guarantee that, it must reconcile a possible late start and retain a visible cleanup obligation. It cannot report confirmed cancellation prematurely.

Return values from stop adapters are matched explicitly. Only positive acknowledged stop/terminal observation resolves the cleanup obligation. Unavailable providers leave durable pending cleanup. A business-terminal run may therefore show `cleanup_pending` as a derived diagnostic.

Deletion is allowed only when no unresolved start/stop intent, external execution obligation, descendant work, or retained resource cleanup obligation remains. Deletion locks the root and checks descendants and intents transactionally. Dispatch cannot create work under a deleting root. No record needed to find or stop an execution is removed first. Pending cleanup returns a specific conflict with an explanation; it is not silently treated as already fenced.

### 8.3 Worktrees and PR observations

Worktrees are reconstructible external resources, with a durable lease and exact repository/ref/base evidence. Preparation emits facts through the mutation boundary. Missing directories cause a resource-unavailable/reconstruction-needed observation, not an unconditional business failure.

Recreate from authoritative refs when safe. If unpublished local work may have been lost or remote refs conflict, report explicit loss/conflict evidence and let configured policy request recovery or operator action. Never claim reconstruction recovered uncommitted work. Preparation is idempotent and does not silently overwrite a checkout belonging to another live execution.

PR state is a typed observation including identity, head/base evidence, observation time, and merged/closed/open facts. GitHub 5xx/timeouts remain unavailable observations and retryable IO. No adapter decides that the cohort completes or fails. Policies such as closed-unmerged replacement belong to the workflow definition. A merged PR can remain valid when its remote branch has been deleted, provided the verified merge/head evidence satisfies the configured contract.

## 9. Generic operator API and presentation

Replace the enumerated v15 command endpoint with a definition-driven scope command endpoint. A request contains command key, checked payload, request ID, scope ID, expected scope version, and exact target revision references where required. Commands, schemas, availability, labels, and consequences come from the pinned definition.

The API exposes immutable definition inspection, scope/run projections, command submission, publication, execution/resource diagnostics, and decision explanations. It separates malformed/schema errors (400/422), missing entities (404), stale targets/version or identity conflicts (409), accepted pending work (202), and transient service failures (503 or an explicitly pending receipt). Internal faults are 500 with trace IDs. A server fault is not labeled a definitive business conflict.

Projections read committed state without GitHub, Git, ACP, or agent calls. External observations are performed by durable effect adapters and then stored. Inbox items are derived from configured available commands/waits and stored diagnostics. A damaged scope yields a scoped diagnostic item rather than making every run's inbox unavailable. Cursor/version information prevents torn projection updates.

The UI renders generic commands and schema-driven feedback forms. Specialized artifact viewers may remain as optional presentation adapters with a generic typed viewer fallback. Adding a workflow or operator command cannot require a component switch on that workflow's stage/worker name.

Every action submits the version and targets the user saw. Retry and abandon cannot fetch a newer version and apply the old intent to it. Each feedback draft is scoped to command, owner version, and target revisions; switching commands does not silently reuse text. Definitive rejection refreshes context and retains a clearly identified draft. Uncertain submission retains its request ID/payload until a receipt resolves it. Remount/reload recovery for pending delivery uses durable client storage or server receipts, not component-only memory.

## 10. Complete replacement and deletion inventory

Paths below are removal/replacement responsibilities, not instructions to preserve old public interfaces. Implement fresh modules from the new contracts. Do not move the same closed vocabulary into Rust, disguise old functions behind a generic facade, or leave a legacy evaluator in the production dependency graph.

| Existing area | Required disposition |
| --- | --- |
| `oakridge-dbos/src/compiler/compile-v15.ts`, `validation/v15-definition.ts` | Delete; Rust compiles the generic language |
| `decision/stage-machine.ts`, `derive.ts`, `materialize-stage.ts`, `snapshot.ts`, `commands.ts`, `schedule-cohorts.ts` | Delete the existing core; rewrite generic evaluation/materialization and protocol contracts |
| `domain/dev-flow-v15.ts`, `v15-action-inputs.ts`, `v15-operator-review.ts`, `v15-review-actions.ts` and workflow-specific attention/cohort types | Delete engine-domain use; behavior moves to configuration and payload schemas |
| `storage/load-stage-cohort.ts`, `materialize-stage.ts`, `apply-stage-event.ts` | Delete; new scope snapshot reader and single commit boundary |
| `storage/postgres-run-record.ts`, `postgres-run-record-repository.ts`, fixed workflow repository contracts | Replace entirely against the new authority model; do not keep a generic writer plus a selected-cohort writer |
| `storage/postgres-dev-flow.ts`, workflow-specific branches in `postgres-operators.ts`, `postgres-domain.ts`, definition repository | Rewrite resource/publication/projection responsibilities; delete workflow progression and duplicated facts |
| `runtime/run-launch-dispatch.ts`, `launch-run.ts`, `cancel-v2-run.ts`, `workflows/run-record-topology.ts` | Replace with generic root creation, scope evaluation and effect delivery; remove both old evaluator paths and v2 operation names |
| `runtime/implementation-worker-session.ts`, `implementation-publication.ts`, `prepare-cohort-repository.ts`, `final-integration.ts` | Delete orchestration modules; extract only tested low-level operations into providers without scope/worker branching |
| `adapters/dev-flow.ts`, workflow-aware executor composition | Remove progression knowledge; providers expose typed operations/results |
| `runtime/compose.ts` | Rewrite composition around Rust client, mutation service, durable effects, and read-only projections; remove shared unbounded single-flight polls |
| Workflow HTTP handlers and hardcoded review/artifact registries | Replace with checked command/publication contracts and definition-driven metadata |
| `kbbl/core/pwa/oakridge` worker review/retry mappings, fixed definition form validation and lifecycle hooks | Delete closed command construction; use generic descriptors, seen versions and receipt delivery |
| Existing v15 definition/prompt copies | Convert behavior into new example bundle; one canonical source, no unreferenced duplicate definitions |
| Architecture tests with old allowlists; tests tied to deleted internals | Replace with ownership/import checks and semantic/recovery tests; retain useful fixture operations |

Low-level Git/GitHub, ACP, SQL, authentication, comments, collaboration transport, and UI components are candidates for reuse, not automatically trusted survivors. Reused modules must have typed operation boundaries, bounded IO, no workflow-name branches, and behavioral evidence. Adapter resource identity and authorization checks remain necessary; domain-specific operations are not prohibited, but they cannot decide enclosing workflow progression.

### Adjacent repository packages

The core cutover does not claim to have rewritten all Python algorithms or all dashboard features. It must remove their ability to act as competing authorities for workflows managed by the new core.

- kbbl retains standalone session execution and its ACP ledger. Remove obsolete workflow tables/readers and workflow decision code still used by the integrated application. Remove legacy compatibility routes that claim acceptance while discarding events; route supported workspace facts into the new durable ingress, or return an explicit unsupported response.
- The dashboard must not use `RunRegistry` memory or event-log age to authorize cancellation/deletion of a core-managed run. Replace launch/cancel/delete and liveness with core API projections and acknowledged resource cleanup. Filesystem study archives may remain read-only imports and be labeled as historical, unmanaged data.
- The Python workspace can retain proposal generation, grading, artifact transforms, and other operation implementations. Its fixed project/protocol coordinator must not also orchestrate a core-managed workflow. A workflow moved to the core expresses iteration/convergence/termination through the same scope language; Python receives bounded selected operations and returns typed results. Leaving the entire old coordinator hidden inside a single adapter and calling that workflow configuration-driven fails this specification.
- Historical standalone study execution, if retained, is outside the completed core rewrite and must not be presented as converted. Before declaring the repository's broader workflow consolidation complete, migrate its managed lifecycle or remove the unsupported managed launch path. This distinction cannot excuse retaining a second engine for the development workflow.

## 11. Development workflow as configuration

Port the existing development behavior into one bundle after the generic language is working. Its six stages are an example, not a schema requirement.

Required behavior includes repository preparation, accepted analysis and planning, complete brief collection review, implementation fan-out from accepted brief keys/dependencies, builder and assessor revision loops, exact review targets, closed-unmerged PR replacement, and final integration for used repositories. Preserve that operator acceptance of an assessment is authoritative even when its verdict is `fail`.

Builder-change feedback and assessor-discussion feedback are different commands with different targets. Configured build revision invalidates the prior assessment; assessor discussion retains the accepted build and publishes either a new assessment revision or explicit unchanged evidence. Partial publication recovery references exactly the retained revisions and publishes only the remaining required outputs when the configured retry contract permits it.

The development parent configures fail-fast cancellation and four held implementation reservations. Those values must also be varied in acceptance tests. Its plan/brief consistency checks can use checked collection constraints or a declared typed validation operation; they cannot become a hidden materializer switch. Repository preparation is a selected operation, not a prerequisite side effect outside the decision ledger.

## 12. Cutover and migration

Build the replacement in an isolated package and test environment. This permits development comparison; production must have one engine and one authority model after cutover. Do not implement selectable old/new evaluators, dual writes, compatibility casts, legacy-run resumption, or conversion of old live runs.

Create a clean baseline for the replacement namespace. Existing applied migrations remain immutable; they can remain deployment history outside active replacement code. New schema upgrades after cutover are forward migrations. Do not edit the old migration files and describe it as a production migration.

The cutover procedure must:

1. Stop old admission and inventory old runs, pending intents, live/uncertain external sessions, and resource leases.
2. Cancel/stop/reconcile all old external work using the old system while its recovery identities still exist. Abort cutover if cleanup cannot be confirmed; retain records and show the unresolved obligations.
3. Export desired historical artifacts and audit records as a read-only archive. Old records do not become executable replacement state.
4. Install the new schema, Rust binary, generic Bun runtime, API and UI; load compiled example bundles.
5. Remove old runtime modules, imports, handlers, dispatch jobs, recovery sweeps, and authoritative workflow columns from the active application.
6. Start new admission and verify generic configuration plus real restart/cancellation behavior.

Retiring old data is a separate explicit operational action after cleanup/archive verification. This specification authorizes no database reset while writing the spec. Rollback before new admission may restore the old release with its intact data. After new runs exist, rollback must account for them and their external work; silently sending them to the old interpreter is impossible and prohibited.

## 13. Implementation sequence

These are replacement milestones, not small fixes declared as completion.

| Milestone | Deliverable and removed assumption | Evidence required |
| --- | --- | --- |
| 1. Contracts | Rust type language, source grammar, checked program, state ownership/schema, wire contract and minimal generic bundle | No workflow name enums; valid/invalid corpus; ownership inventory |
| 2. Pure engine | Compiler, evaluator, explanation and materializer | One/five/seven-child flows, different workers/states/outcomes, no IO |
| 3. Authority | New PostgreSQL schema, consistent snapshot, single versioned commit and receipts | Atomicity, concurrent decisions, capacity and replay against real PostgreSQL |
| 4. Effects | Provider contracts, stable invocations, leases, bounded delivery, stop/reconciliation | Crash matrix, lost start/stop responses, uncertain cancellation, independent progress |
| 5. Surface | Generic API, projections, command descriptors, exact target/version UI | Browser tests for new command names, drafts, stale actions, uncertain receipts |
| 6. Example | Development bundle and adapter operations | Entire existing behavior through generic engine; alternative parent policy and capacity |
| 7. Removal | Old core/API/schema authority paths removed; adjacent consumers adapted | Dependency graph, symbol/schema inventory, fresh boot, cutover rehearsal |

Do not port the development workflow first and infer a generic language from its six stages. Establish the counterexample workflows before the development bundle to expose accidental coupling early.

## 14. Required acceptance evidence

### Architecture and configurability

- Execute one-, five-, six-, and seven-child definitions using the same binary and database schema.
- Rename stages, workers, private states, outcomes, commands, prompt locations, and output names without engine/adapter edits.
- Add a worker, reuse one prompt across actions, and add a payload schema with existing type constructs.
- Replace child private logic while preserving its exported contract; parent source and configuration remain unchanged.
- Change sibling failure behavior and capacity 1/4/8 through configuration. Prove held review/merge reservations deny another activation until release.
- Reject private reads, wrong command scope, missing handlers, invalid/null bindings, unknown fields, unsupported authorization, and the unconditional dead initial wait from the review probe.
- Check core import boundaries and active dependency graphs. A regex over two files or a broad allowlist is insufficient. Workflow-specific identifiers are allowed in example bundles and domain operations, never as interpreter branches.

### State and concurrency

- State/receipt/intents/slots/reservations commit atomically or remain unchanged.
- Concurrent activation cannot exceed configured capacity; concurrent publications cannot overwrite current slots without predecessor/version checks.
- A change to a consumed child export, output, resource observation or membership invalidates an old decision even when its local scope version did not change.
- There is one current acceptance representation. Projections rebuild from authoritative records after process/cache loss.
- Exact replay returns the original result before and after terminal state; altered replay conflicts; stale review cannot approve newer content.
- Pin definition, prompt, schema, presentation and operation semantics across a newer bundle/provider deployment.

### Real crash and boundary testing

Kill a real backend before/after decision commit, before dispatch, after provider acceptance but before its response, after response but before binding persistence, after publication commit but before acknowledgement, after revocation but before stop, and after stop but before acknowledgement. Restart with empty process memory and missing/duplicate wake hints. Assert one selected execution per identity and persistent cleanup obligations, not just a final happy-path outcome.

- Reproduce cancel-then-delete: deletion is refused until every external execution and uncertain start has resolved cleanup; no stop identity disappears.
- Inject `executor_unavailable` stop results; they never produce confirmed termination.
- Cancel while start is uncertain; delayed start is tombstoned or reconciled/stopped and its obligation retained.
- Hang response headers and bodies for one provider/PR; bounded timeout permits other owners to progress.
- Inject PR 5xx/discovery failure; retryable IO does not become permanent workflow interruption.
- Lose a worktree; safe reconstruction succeeds or explicit unrecoverable evidence reaches configured recovery, without an adapter committing scope failure.
- Change PR discovery/head between repeated dispatch attempts; the selected invocation remains byte-identical.
- Replay partial publication; carry-forward is explicitly authorized and does not inherit unrelated/fenced outputs.

### UI and adjacent consumers

- Switching discussion/change commands does not silently carry the wrong draft.
- A stale retry/abandon action conflicts instead of targeting a newly changed execution.
- Lost submission response plus remount/reload resolves the original receipt without inventing a new request.
- Inbox reads perform no forge/provider IO and isolate an invalid scope.
- Restart dashboard/backend during managed Python work: durable liveness prevents deletion and cancellation remains available. Coordination completion during grading does not authorize deletion of live output.
- Unsupported workspace-event routing returns an explicit failure; successful acknowledgement corresponds to durable acceptance.

Rust unit/compiler tests run without PostgreSQL or network. Storage/adapter integration tests are separately named and use real PostgreSQL, Git fixtures, and scripted ACP/external boundaries. Browser acceptance and process-kill tests run explicitly. Real-agent smoke tests are a separate reported category; a skipped real-agent test cannot count as a completed gate. Existing passing tests are useful regression fixtures, not proof of the new architecture.

## 15. Definition of done

The rewrite is complete only when all of the following are demonstrated together:

1. Generic counterexample workflows and the development workflow execute through the same pure Rust core.
2. PostgreSQL has one current authority per workflow fact and one transactional mutation boundary.
3. All business progression, parent policy, review routing and action bindings trace to pinned configuration.
4. Durable recovery handles uncertain IO and cancellation without losing execution/resource identities.
5. Generic API/UI additions require configuration changes rather than hardcoded workflow commands.
6. Old core modules, dual evaluator paths, active legacy schema authorities and compatibility shims are removed.
7. Tests establish architecture, concurrency, semantic behavior and real restart recovery, with omissions/skips reported.
8. Documentation and generated repository instructions describe the actual new model and cutover; old specifications cannot still claim to govern implementation.

Report evidence by requirement and exact commit. A green suite, a working six-stage demo, a Rust port of the existing enums, or partial removal is not completion.