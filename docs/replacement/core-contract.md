# Cohort 1 core contract and validation

Source of truth: [original run specification](governing-specification.md), sections 3–5 and 7.3. The source was recovered from the original run's persisted brief, not reconstructed from its assessment. [Ownership inventory](ownership-inventory.md) separates this cohort from the later production cutover.

The model crate declares the closed source language, nominal IDs, resolved checked values, checked expressions, invocation contracts, decision mutations, snapshots and protocol. The compiler resolves schemas, event vocabularies, child visibility, action bindings, capability pins, prerequisites and finite state/event control flow. The evaluator consumes those checked types and supplied snapshot values; it performs no IO. The CLI and Bun client own decoding, bounded frames and subprocess lifecycle.

`workflow-core/fixtures/source-schema.json` is generated from `DefinitionBundle`. `oakridge-dbos/src/core-client/generated-contracts.ts` is generated from the protocol model and includes a runtime response decoder. Run `bash scripts/generate-core-contracts.sh`; CI uses `--check` to reject drift in both artifacts. The five protocol operations are compile, validate_payload, evaluate, materialize and explain. Protocol version 1 is retained; these finalized cohort contracts replace the earlier incomplete cohort draft.

Arbitrary JSON is confined to source literals, initial state, error payloads and ingress decoding. Checked records use resolved numeric field IDs and typed dictionary entries. Optional fields acquire compiler-owned `$optional/<record>/<field-id>` schemas; declared local events acquire `$trigger/<scope>` schemas. Reserved collisions fail. Action invocations contain frozen provider pins/settings/tools/output authority and checked bound input; they contain no source binding expressions or mutable prompt references.

Rust canonicalizes the original bundle using sorted JSON object keys and semantic declaration-array order, then hashes it with pinned SHA-256. Prompt contents and operation/presentation contracts participate. The checked source additionally contains the deterministic compiler-owned schemas; it does not change the original bundle digest. Language and evaluator versions are both pinned in the checked program. c2 must enforce same-key/version immutability when persisting this contract.

Finite analysis is conservative for payload-dependent predicates: it considers both branches, rejects structurally unreachable states/actions/outcomes, and rejects closed nonterminal regions without an outcome route. It is not a theorem prover for payload relations. Dynamic collection creation validates the complete key/dependency/input batch before returning any children. Pure evaluation emits capacity acquisition/release intents; c2 must enforce atomic reservation/version checks and persist outcomes, publication grants, read sets and effects.

Section 5 rejection evidence lives in `workflow-core/crates/compiler/tests/rejections.rs`:

| Source requirement | Behavioral evidence |
| --- | --- |
| 1. Symbols, versions, source/content | missing/duplicate symbols, duplicate JSON keys, unknown fields, missing/escaping prompts, unsupported language |
| 2. Schema/port/brand/binding/nullability | invalid bounds, recursive schemas, wrong ports/brands, missing record bindings, nullable input; evaluator presence-match tests for whole optional payloads and optional record fields |
| 3. Visibility and events | private child reads and nonlocal command cases |
| 4. Control flow and leaf consistency | exhaustive match, duplicate writes, invalid state assignment, exclusive launches, launch/stop conflicts |
| 5. Prerequisites/templates | static DAG cycles, invalid dynamic mappings; evaluator batch/cycle/missing-dependency tests |
| 6. Structural reachability/liveness | unreachable states/actions/outcomes, initial waits without continuation, closed-region analysis |
| 7. Required command handling | required available command falling into generic rejection |
| 8. Provider capability pins | unsupported settings, unavailable operation versions, unhonorable tools |
| 9. Publication/presentation | unauthorized output producers, unsupported revision policy and viewer semantics |

Shared valid fixtures cover one/five/six/seven children and dynamic collections. Shared invalid fixtures include a diagnostic manifest and run through both Rust and the actual Bun subprocess client. Evaluator tests also cover capacities 1/4/8, renamed states/workers/commands, sibling policy changes, deterministic replay, observation versions, predecision bindings and separate revoke/stop intents. Compiler serialization is tested for deterministic bytes across repeated builds.

The subprocess queue is bounded (default 64), frames are bounded to 1 MiB and responses to 256 KiB. Requests carry explicit IDs. Malformed responses, unknown IDs and deadlines quarantine the child and fail pending callers. Domain errors remain distinct from transport errors. The process uses newline-framed JSON, rejects duplicate keys and unknown source fields, and signals oversized response truncation explicitly.

The PWA now owns HTTP projection descriptors matching the existing serializers, with an exhaustive transitive import test and real HTTP serializer contract tests. Its legacy review/retry choices are local compatibility selectors for the current server; replacing those choices with generic checked descriptors remains c4. Full source-language validation belongs to the Rust/backend boundary; the current definition form checks its HTTP envelope. This change does not switch the running server to the Rust engine or perform the c2 database rewrite.

TypeScript packages are checked independently by `bun run typecheck`, which runs `tsc --noEmit` against kbbl, lbc-dashboard and oakridge-dbos. The root `tsconfig.json` references organize the editor workspace; they are not composite build references and `tsc -p tsconfig.json` checks no source files. Cross-package HTTP contract tests are intentional; the PWA dependency graph is enforced separately by `oakridge-dbos/tests/pwa-import-boundary.test.ts`.

Validation commands:

```sh
(cd workflow-core && cargo fmt --check && cargo clippy --locked --all-targets -- -D warnings && cargo test --locked && cargo build --locked -p workflow-cli)
bash scripts/generate-core-contracts.sh --check
bun run typecheck
bun test oakridge-dbos/tests/core-fixture-parity.test.ts oakridge-dbos/tests/pwa-import-boundary.test.ts kbbl/core/server/handlers/oakridge-pwa-wire.contract.test.ts
bun run --filter kbbl test:pwa
```
