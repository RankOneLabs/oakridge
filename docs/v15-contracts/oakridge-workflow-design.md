# Oakridge workflow design draft

Status: superseded by the [v15 refactor specification](oakridge-workflow-refactor-spec.md) and [complete workflow contract](oakridge-v15-workflow-schema.md). Those documents govern the Bun implementation, cohort-owned application decisions, mechanical stage coordination, and clean cutover. The text below is historical background.

Oakridge workflows are nested, typed decision flows defined by configuration. Workers publish artifacts; configured rules interpret their state and determine eligible actions. A completed unit exposes an outcome to its enclosing coordinator, which applies its own configured rules. State and the logic that interprets it belong to the smallest unit that owns their meaning.

This document defines the target architecture for refactoring `epic/wf-interpreter`. It records the model established in the current discussion, independently of earlier specifications. Success requires both correct execution and preservation of these boundaries. A passing workflow or a green test suite alone does not establish success.

## State ownership and composition

Workers know how to publish original artifacts, derivations, and reviews. Publishing an artifact or finishing a session does not establish that a stage has passed. The configured decision flow responsible for that artifact evaluates its state and related evidence.

Approval and a request for updates with feedback are additional states bound to the artifact they concern. Their payloads and allowed transitions are part of the artifact's local contract. They do not require a separate workflow mechanism or a special form type. Review publications retain a typed relationship to the artifact revision they review; feedback belongs to that relationship rather than an unstructured global field.

An enclosing coordinator consumes the child's declared contract, not its internal implementation. It can connect a declared outcome to an action through configuration without knowing that a particular outcome arose from an assessment approval, notes, or a requested revision. A parent may declare how it handles an exposed outcome; it must not reproduce the child's reasoning that produces it.

This composition repeats at every boundary. Artifact decisions participate in stage decisions; stage or cohort outcomes participate in an enclosing flow; the run coordinator starts eligible stages from their declared requirements and outcomes. The hierarchy follows ownership rather than a mandatory sequence of globally named state machines.

Point-free composition means wiring declared inputs and outcomes together. It does not mean hiding procedural branches inside an adapter or a parent callback.

## Conceptual contracts

These are the domain contracts the refactor must express as named types before implementation. Their concrete Rust and serialized representations remain implementation decisions.

| Contract | Meaning |
| --- | --- |
| Artifact definition | Declares payload variants, local states, allowed state updates, relationships, and the contract exposed to its decision flow. |
| Artifact revision | Identifies a published payload and its provenance, including derivation or review relationships. State updates identify the revision they concern. |
| Worker definition | Declares required inputs, instructions, execution capability, and authorized publications. It does not decide stage completion. |
| Decision flow definition | Declares its scope, inputs, state, match rules, eligible actions, and exposed outcomes. It can compose child flows through their contracts. |
| Outcome contract | Defines the variants and payloads visible across a boundary. Private child state is absent from this contract. |
| Action definition | Describes a state update, worker launch, child activation, or completion selected by a rule, with typed inputs. |
| Checked flow | Contains resolved references and verified connections produced by configuration compilation. |
| Execution record | Tracks an instance of a checked flow, its local state, facts, selected actions, and execution results. |

Flow-specific names and variants are configuration data. The implementation language defines the constructs needed to represent and check them; it must not close the engine over names such as `build_review` or assessment-specific approval states.

## Eligibility and execution

The execution model is a repeated evaluation of configured rules against committed shared state:

1. A worker, operator, or external observer submits a typed publication or fact.
2. The boundary validates its identity, authorization, revision, and payload contract.
3. The owning decision flow interprets that fact using its checked rules and selects eligible actions.
4. Persistence commits the resulting state changes and durable action intents atomically.
5. The runtime executes those actions and reports their results as facts.
6. Resulting changes trigger further evaluation. An exposed child outcome makes its enclosing flow eligible for evaluation.

Shared state is authoritative storage, not permission for every consumer to interpret every field. Reads used to decide progression are limited to the unit's own state and the contracts it explicitly consumes.

The decision evaluator is deterministic and free of IO. Its input is the checked configuration and an authoritative state snapshot; its output is a typed decision describing changes and actions. Database repositories commit that decision. HTTP handlers submit facts. Adapters perform operations and report facts. A durable execution framework schedules and retries operations. These components must not independently choose workflow progression.

Dependencies, concurrency, cancellation, and failure propagation also require explicit ownership. Generic mechanisms may enforce configured capacity or prevent duplicate execution, but business policies such as whether one failed child stops its siblings belong to the enclosing flow's configuration. They are not implicit engine behavior.

Each selected action has a stable identity. Repeated evaluation or duplicate delivery cannot launch duplicate work or repeat a committed state update. Eligibility explanations identify the owning unit, configuration version, matched rule, and supporting facts.

## Plan and implementation examples

In a plan stage, a worker publishes a plan. The local decision flow exposes the configured review actions. Approval satisfies the stage's configured completion conditions. An update request binds feedback to the reviewed revision and makes revision work eligible. The enclosing run coordinator sees the stage's exposed outcome and determines which stages may start next.

In an implementation stage, the build worker publishes a PR artifact. Its publication makes assessment work eligible. The assessment worker publishes a review with pass, pass with notes, or fail. The local configured flow interprets that review together with the required operator state updates. Required updates make build work eligible again, with the relevant artifact revisions and findings supplied through declared input bindings. When the configured conditions are met, the stage exposes its completion outcome.

The run coordinator does not inspect assessment dispositions or special-case a build state. Replacing either stage's internal decision flow does not require changing its parent when its exposed contract remains compatible.

## Configuration compilation and static analysis

Configuration is a program in a small declarative language. Compilation checks that program before it can be stored as executable configuration or used to launch a run. Deserialization alone is insufficient.

The initial language should use finite tagged state and outcome variants, typed payloads, declared connections, and restricted match rules. Arbitrary scripts or callbacks that decide progression would undermine static analysis. Domain operations can remain implemented capabilities, but their input and output contracts must be declared and checked. External observations arrive as facts rather than hidden eligibility decisions.

The compiler must reject:

- Missing required decision flows, unresolved references, and unsupported configuration fields.
- Incompatible input, outcome, publication, and action payload contracts.
- Matches that omit required variants, ambiguous rule selection, and unintended shadowing.
- Reads across a private state boundary.
- Invalid state updates, unreachable declared states, and invalid completion references.
- Cycles in prerequisite dependencies that would prevent activation.
- Worker launches without required bindings or with unauthorized publication contracts.

Intentional revision loops are valid decision-flow transitions. They must not be confused with cycles in prerequisites where every unit waits for another unit to start or complete.

Dynamic collections require validation when their concrete members arrive. Validate identities, dependency references, and prerequisite cycles before activating them. The rule is known before execution even when the collection's contents are not.

Static checking establishes structural validity and declared coverage. It does not prove that an agent will produce a useful artifact, an operator will approve it, or an external service will respond. Those are runtime facts and operational concerns.

## Rust and the existing runtime

Rust is the proposed implementation language for the small configuration compiler and pure interpreter. Enums, typed payloads, exhaustive matching, and module privacy can enforce the implementation's contracts. Dynamically authored workflows still need the configuration compiler to check their own variants and connections.

The flow-specific checked representation must preserve ownership boundaries. Wrapping every value in arbitrary JSON and allowing unrestricted reads would surrender the benefit of the type model even if the implementation were written in Rust.

The language choice does not require replacing the operator UI, worker integrations, or durable execution framework. How the Rust core connects to the current Bun and DBOS runtime is an open implementation decision for the refactor specification. This design does not select a new transport, binding mechanism, or durability dependency.

## Persistence and versioning

The database stores generic execution identities, configuration references, publications and revisions, relationships, local state, events, and durable action records. Flow-specific stages, outcome variants, and state names are data rather than database enums or dedicated lifecycle columns.

Changing a flow produces a new immutable configuration version. It does not require a database migration, recompiling the interpreter, or changing a parent whose consumed contracts remain compatible. Runs pin their checked configuration and the implementation versions needed to interpret it. Prompt and capability changes must not silently change the meaning of an existing run.

Applied schema migrations remain immutable. Changes to the storage structure use forward migrations. Changing an executing run's configuration requires an explicit compatibility procedure; silently reading it through the latest flow definition is prohibited. Development database resets are separate operations, not the production upgrade path.

## Architectural acceptance criteria

The refactor is complete only when behavior and boundaries are demonstrated together:

- Plan review and implementation assessment execute with revision loops and correctly bound feedback.
- A stage's internal assessment flow can change while its parent continues to consume the same declared outcome contract.
- Stage names, private state names, and review variants can change through configuration without engine, adapter, or database schema changes.
- A second flow with different worker composition executes through the same interpreter without additional progression branches.
- All progression decisions can be traced to an owning configured rule. There are no alternate decision paths in HTTP, persistence, composition code, or observers.
- Invalid connections, missing match coverage, private-state access, and prerequisite cycles fail at the appropriate compilation or materialization boundary.
- Every accepted configuration field has defined execution semantics. Unsupported features fail clearly.
- Duplicate facts, retries, concurrent updates, and restart recovery preserve committed decisions and avoid duplicate actions.
- A new configuration version leaves existing runs pinned to their original interpretation.
- Upgrading storage preserves supported existing records through forward migrations.

Tests should focus on semantic correctness, boundary behavior, and recovery. Rust compiler guarantees do not need duplicate unit tests. Configuration checking still needs tests because the Rust compiler does not inspect dynamically supplied workflows. Real persistence and integration tests remain necessary; silently skipped checks cannot establish acceptance.

## Refactor specification to follow

The next document should map each current module to its target responsibility and define incremental changes against this design. Retain useful execution integrations, operator surfaces, and persistence protections where they satisfy these boundaries. Remove competing progression paths rather than adding another orchestration layer alongside them.

Before selecting implementation work, resolve the exact serialized language, how outcome contracts become visible across scopes, rule selection and conflict semantics, artifact revision binding, Rust integration, and the compatibility path for existing runs. Failure and cancellation behavior must be expressed as configured policies, including how those policies select cleanup actions for running workers.

For every refactor step, the specification should name the architectural invariant it establishes, the existing decision path it removes, and the behavioral evidence required. A change that gets one workflow passing by introducing a private-state dependency or a workflow-specific engine branch fails acceptance.
