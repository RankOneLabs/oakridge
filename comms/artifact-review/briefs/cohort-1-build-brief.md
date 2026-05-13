# Cohort 1: Review-responder agents — build brief

## Goal
Land two Python agents in `oakridge/builder/src/builder/` — `plan_review_responder.py` and `build_brief_review_responder.py` — plus the kbbl-side webhook consumer that listens for `thread.agent_response_started` from safir and dispatches to the right agent. Each agent reads a snapshot of the live artifact, the pinged thread, other thread metadata, and parent context; calls one tool per affordance to make atom edits via safir; surfaces 409 conflicts by name in its reply; posts a mandatory final `reply_to_thread`; and the consumer reports `.completed` or `.failed` back to safir. End state: cohort 2/3 can click "ping" in the PWA and an agent responds end-to-end.

## Active subgoals

1. **Shared scaffolding for review responders.** Create `oakridge/builder/src/builder/review_responder_base.py` with: a `ReviewResponderContext` pydantic model (fields: `target_type: Literal['plan','build_brief']`, `target_id: str`, `thread_id: str`, `thread: ThreadSnapshot`, `atom_map: dict[str, str]`, `other_open_threads: list[ThreadMetadata]`, `parent_task_notes: str`, `dependency_briefs_notes: list[str] | None`), a `ConflictRecord` pydantic model (`anchor`, `attempted_value`, `current_value`, `latest_edit_id`), and a `record_conflict(ctx, conflict)` helper that appends to the agent's working memory list. Add a `_call_safir_or_record_conflict(client, request)` helper that wraps a single atom_edit POST: on 200 returns the edit record, on 409 (`error: 'stale_prev_value'`) records the conflict and returns `None`, on any other error raises. The shape of these helpers mirrors `oakridge/builder/src/builder/build_agent.py` style (pydantic models for I/O, async functions calling a typed client). **Exit signal:** `uv run pytest builder/tests/test_review_responder_base.py` green; the conflict-recording path is covered by a unit test that hands the helper a stub returning 409.

2. **Extend `safir-py` (or a builder-local wrapper) with the review API methods.** In `oakridge/safir-py/src/safir_py/client.py`, add async methods to the existing `SafirClient` class: `get_plan(plan_id)`, `get_atom_map(target_type, target_id)`, `get_thread(thread_id)`, `list_open_threads(target_type, target_id)`, `post_atom_edit(target_type, target_id, body)` (returns either the edit record or raises `SafirAtomEditConflict(current_value, latest_edit_id, edited_by, created_at)` on 409 stale_prev_value), `post_thread_message(thread_id, body)`, `post_agent_response(thread_id, status, reply_message_id=None, error=None)`. Each method follows the existing `httpx.AsyncClient` pattern in `safir-py`. **Exit signal:** `uv run pytest safir-py/tests/test_review_client.py` green against a `respx`-mocked safir (use whatever mocking lib the repo already uses; if none, hand-roll an `httpx.MockTransport`).

3. **`plan_review_responder.py`.** New file at `oakridge/builder/src/builder/plan_review_responder.py`. System prompt (`PLAN_REVIEW_RESPONDER_SYSTEM_PROMPT` constant) modeled after `BUILD_AGENT_SYSTEM_PROMPT` in `build_agent.py:24-70`. Key sections in the prompt: who you are (a plan-review responder agent invoked when an operator pings a thread); what the snapshot vs live state contract is (cohort 0 §0.7 + 1.5 — you see a frozen view; CAS handles drift; surface conflicts in your reply); the cross-anchor callout convention (if you edit cohorts/edges beyond the thread's anchor, you MUST name them in your reply); the mandatory `reply_to_thread` at end of turn. Tools (one Python class per affordance in the existing `jig` `ToolRegistry` style — pattern: `oakridge/builder/src/builder/tools/bash.py`): `EditCohortTool`, `AddCohortTool`, `DeleteCohortTool`, `SplitCohortTool`, `MergeCohortsTool`, `AddEdgeTool`, `DeleteEdgeTool`, `ReplyToThreadTool`. Tool input schemas use pydantic. Tool implementations call into the safir client via the helper from step 1: each one translates to a sequence of `POST /atoms/plan/:plan_id/edits` with the relevant anchors (e.g., `EditCohortTool` issues one edit per attribute being changed; `SplitCohortTool` issues N-1 delete-edge edits, one delete-cohort edit on the original, K add-cohort edits for the splits, and the agent-supplied dep migrations). Cycle/missing-edge-target validation is done client-side before posting and reported as a tool error (the agent re-plans). `AddCohortTool` allocates the next cohort_index by reading the live atom map keys (`cohorts[N+1]`) — never re-packs. Model: `claude-opus-4-7`. Entry point: `async def run_plan_review_responder(ctx: ReviewResponderContext, client: SafirClient) -> ResponderResult` (returns the final reply message id + the list of conflicts). The agent runs via `jig.core.runner.run_agent` exactly like `run_build_agent` in `build_agent.py`. **Exit signal:** `uv run pytest builder/tests/test_plan_review_responder.py` green; the test invokes the agent with a stub safir snapshot + a fake LLM that emits a canned tool sequence; verifies the resulting POST sequence is correct.

4. **`build_brief_review_responder.py`.** New file at `oakridge/builder/src/builder/build_brief_review_responder.py`. Same scaffolding as step 3, scoped to build briefs. Tools: `EditAtomTool` (generic: `anchor`, `new_value`, `prev_value`), `AppendAtomTool` (`field`, `value` — for `active_subgoals`, `decisions_made`, `approaches_rejected`, `files_in_scope`, `open_questions`; for object-list fields the value is the object `{decision, rationale}` etc.; the tool resolves the next index from the live atom map and posts the appropriate atom_edit with `prev_value=None` and the new index anchor), `DeleteAtomTool` (anchor of element to delete; for list-element atoms the tool also issues a re-shift sequence: a chain of edits that shifts subsequent indices down by one, each with the correct prev_value from the snapshot), `ReplyToThreadTool` (same as step 3). The shift behavior matches spec §0.2 + §1.2: "After deletion, subsequent indices shift; the agent's subsequent tool calls must use post-shift indices. The reply should note the shift." System prompt enforces this with an explicit clause. Model: `claude-opus-4-7`. Entry point: `async def run_build_brief_review_responder(ctx, client) -> ResponderResult`. **Exit signal:** test analogous to step 3, plus a specific test for the delete-then-shift sequence (delete `decisions_made[1]` from a 4-element list; assert the shift edits land in the expected order with the correct prev_values).

5. **Webhook consumer in kbbl: dispatch on `thread.agent_response_started`.** New file `oakridge/kbbl/core/server/handlers/review-responder-consumer.ts`. Imports the safir-webhook receiver's deduplication + token-validation primitives (re-export them from `safir-webhook.ts` if currently private). Subscribes to incoming webhooks; for `event === 'thread.agent_response_started'`: loads the thread (`GET /threads/:id`), atom map (`GET /atoms/:target_type/:target_id`), other open threads (`GET /artifacts/:target_type/:target_id/threads?status=open`), parent context: for `plan` target the `parent_task_id` from the plan record + that task's notes; for `build_brief` target the cohort task's notes + the dep build briefs' notes (via the run's dep edges). Spawns a python subprocess that runs the agent — pattern: `python -m builder.review_responder_runner --target-type <t> --target-id <id> --thread-id <id> --safir-base-url <url>`, similar to how `oakridge/kbbl/adapters/claude-code/spawn.ts` constructs its subprocess command but simpler (no settings.json hook injection — the responder runs in a tightly scoped tool environment with no Bash). The subprocess writes a JSONL result to stdout; the consumer parses the final line as `{status: 'completed'|'failed', reply_message_id?, error?, conflicts: [...]}` and POSTs `/threads/:id/agent-response` to safir with that body. Add the new entry point: `oakridge/builder/src/builder/review_responder_runner.py` — argparse CLI that reads the stdin context payload, loads the right responder, runs it, dumps the result as JSONL. The consumer registers via the existing webhook subscriber registration in `safir-webhook.ts` (add to a `RESPONDER_EVENTS` list parallel to `DISPATCHABLE_EVENTS`, or extend `DISPATCHABLE_EVENTS` with a separate dispatch branch — pattern: branch on event type in `safir-webhook.ts:dispatchWebhook`). **Exit signal:** `bun test kbbl/core/server/handlers/review-responder-consumer.test.ts` green; an integration test fires a synthetic webhook, sees the subprocess invoked with the right args (using a python stub), sees the right `/agent-response` POST land against a recorded safir.

6. **End-to-end conflict-surfacing integration test.** New file `oakridge/builder/tests/test_review_responder_conflict_e2e.py`. Spins up a `respx`-mocked safir; loads a real plan_review_responder against a fake LLM that emits tool calls; arranges the mock to return 409 stale_prev_value on the second tool call; asserts (a) the agent does NOT auto-retry, (b) the final `reply_to_thread` body contains the conflicted anchor and the current value by name, (c) the agent continues to post the third tool call on a different anchor (cross-anchor edits should land even when the second one conflicts). Add an analogous test for the build_brief responder. **Exit signal:** both tests green.

## Decisions made

- **Punt #3 resolved: webhook consumer lives in kbbl.** New file `oakridge/kbbl/core/server/handlers/review-responder-consumer.ts`. **Rationale:** kbbl already owns the webhook receiver, the subprocess-spawning patterns (`adapters/claude-code/spawn.ts`), and the SSE fan-out that cohorts 2/3 build on. Putting the consumer here keeps everything that watches webhooks in one Bun process; the builder stays a pure agent library.

- **Punt #5 resolved: agent sees live snapshot + thread only; no revision history in prompt.** **Rationale:** spec V1 position; cheaper to add later than to manage prompt bloat. History is queryable via the `GET /atoms/.../history` endpoint if the responder needs it in a tool call.

- **Punt #9 resolved: split/merge migrate dependencies via agent-supplied mapping, not auto.** Tools `SplitCohortTool` and `MergeCohortsTool` take an explicit `dep_migration` argument shaped as `{from_edge: [from, to], to_edges: [[from', to'], ...]}`. **Rationale:** spec §1.1; less magic; clearer in the trace; the agent reasons about which split/merge half should inherit each edge.

- **One Python tool class per affordance (no generic `mutate_plan`).** Mirrors the existing `tools/` directory structure in `oakridge/builder/src/builder/tools/`. **Rationale:** anchored intent in the trace bounds the agent's tool-call surface; mirrors the `BashTool`/`EditTool`/etc. pattern; matches spec §1.1.

- **Subprocess invocation pattern, not in-process import.** The consumer spawns `python -m builder.review_responder_runner ...`. **Rationale:** matches `kbbl/adapters/claude-code/spawn.ts` pattern; keeps the kbbl Bun process unmixed with Python; failures (crashes, timeouts) are pid-tracked and observable.

- **Agent context payload passed via stdin (JSON), not args.** The consumer writes the full `ReviewResponderContext` JSON to the subprocess stdin; argparse only handles `--target-type`, `--target-id`, `--thread-id`, `--safir-base-url`. **Rationale:** atom maps are large enough that command-line passage hits arg-length limits; stdin is unbounded and structured.

- **`AddCohortTool` allocates the next cohort_index by reading live atom map keys.** Extends the index space; never re-packs. **Rationale:** spec V1 (open question #1 in spec) + plan's punt #1 resolution; revision history reads more naturally when indices are stable, even with gaps.

- **`DeleteAtomTool` for list elements issues an explicit shift sequence.** After deleting `decisions_made[1]` from a 4-element list, the tool posts: delete on `decisions_made[1]`, then edit on `decisions_made[1]` (was [2]), edit on `decisions_made[2]` (was [3]), delete on `decisions_made[3]`. Each with the prev_value from the snapshot. **Rationale:** spec §0.2 + §1.2 say indices shift; the alternative (tombstoning) is deferred per plan punt #2. The agent's reply must note the shift per system prompt rule.

- **Cycle and missing-edge-target validation happens client-side in the tool before any POST.** Tool raises `ToolValidationError(message)` which the jig runner surfaces back to the LLM; the agent then re-plans. **Rationale:** half-applied DAG edits would corrupt the plan; validating up front means either all of a tool call's edits land or none.

- **Cross-anchor edits are allowed and required to be called out in the reply.** System prompt enforces; no programmatic check. **Rationale:** spec §1.1 + §1.2; the agent often must touch sibling atoms to keep the artifact consistent; suppressing them would make the artifact incoherent; invisible touches would surprise the operator.

- **Conflicts surface in reply by anchor + current value; agent records them via the helper from subgoal 1.** The reply body includes a "Conflicts I hit" subsection when conflicts are non-empty. **Rationale:** spec §1.4; the operator can verify each one and re-edit as needed without re-running the agent.

- **`reply_to_thread` is mandatory at end of turn.** Enforced by system prompt; the runner checks: if the agent terminates without calling it, the runner posts a synthetic reply ("agent terminated without a reply; consult logs") and reports failure. **Rationale:** spec §1.1; without a reply the operator has nothing to evaluate. Synthetic-reply fallback prevents stuck threads on agent bugs.

- **Model `claude-opus-4-7` for both responders.** **Rationale:** spec §1.1/§1.2; matches planner-1's tier; reasoning-heavy operations on whole-artifact structure.

- **Consumer reports back via `POST /threads/:id/agent-response` (cohort 0's endpoint).** Body shape `{status, reply_message_id?, error?}`. **Rationale:** cohort 0 already ships this endpoint and the resulting webhook; cohort 1 just consumes the trigger and reports the outcome.

- **Agent failure (uncaught exception, validation storm, subprocess crash) reports `.failed` with stderr tail in `error`.** Reply (if one landed before the crash) stays in place. **Rationale:** spec §1.3 failure mode: "partial state is rolled back where possible; reply still lands with a 'I hit conflicts on N atoms' body if applicable."

- **Ping rejections at cohort-0 boundary are honored, not retried.** A ping on a frozen artifact / resolved thread returns 409 from cohort 0; the consumer treats that as a no-op (no agent invocation; no `.failed` posted because the trigger never fired). **Rationale:** the trigger never sets `agent_responding=1` in those cases — there's nothing to clear.

## Approaches rejected

- **In-process agent invocation from kbbl's Bun process.** Rejected: mixing Python and Bun in one process is hard; subprocess matches existing pattern and isolates failures.

- **Generic `mutate_plan(edits[])` tool.** Rejected: removes anchored intent from the trace; one tool per affordance bounds the agent's reasoning and makes review easier.

- **Auto-retry on 409.** Rejected: races operator; spec §1.4 explicitly forbids it.

- **Suppress cross-anchor edits.** Rejected: artifact incoherence is worse than surprise; transparency rule handles surprise.

- **Tombstone indices instead of shifting on delete.** Rejected for v1 per plan punt #2; reversible later.

- **Read full atom_edits history into the agent prompt.** Rejected per plan punt #5; cost without proven need.

- **Consumer in builder.** Rejected per plan punt #3 resolution; kbbl is the natural home.

- **Use the existing `safir-webhook.ts` directly (no new file) and add a switch.** Rejected: the responder dispatch logic is non-trivial (loads multiple safir resources, builds the context payload, spawns + monitors a subprocess) — separating it keeps `safir-webhook.ts` focused on receiver-side concerns (auth, dedup, type validation).

## Open questions (punted decisions)

1. **(a)** Whether the subprocess runner should stream tool-call progress back to the consumer (via stdout JSONL events) for live SSE telemetry to the PWA, or only emit the final result line.
   **(b)** Final result line only.
   **(c)** Deferring until cohort 2/3 have observed real responder runtimes. If responders routinely run >20s, live progress events become valuable; otherwise the "agent thinking..." indicator is enough. The hook for adding streaming later is small: the runner already writes JSONL.

2. **(a)** Whether the consumer should serialize same-thread pings (queue) or reject concurrent pings (409 from the cohort-0 endpoint already handles this via `agent_responding=1` — a second ping while the first is in flight is rejected at trigger time).
   **(b)** Reject (cohort 0 already does it; consumer needs no additional logic).
   **(c)** Verify in subgoal 5's test that cohort 0's `agent_responding` guard fires on the second ping. If not, this becomes a real problem and the consumer would need its own queue.

3. **(a)** Whether responder agents emit jig tracing events (per the agent-dev-flow tracing convention) for each tool call, or only a top-level "agent invoked" event.
   **(b)** Per-tool-call jig events.
   **(c)** Deferring concrete event-name choices until the agent file is being written and the existing `StdoutTracer` shape from `build_agent.py:10` is in front of the build agent. Likely zero-decision once the file is open.

## Next action
Open `oakridge/builder/src/builder/build_agent.py` and use it as the structural template, then create `review_responder_base.py` with the `ReviewResponderContext` model and the `_call_safir_or_record_conflict` helper — that's subgoal 1 in flight.

## Deviations from plan

None — built exactly as specified.
