# Spec 03 Langfuse pilot: contract decisions

These are **planner recommendations pending operator confirmation**. They pin the
pilot's contract so the storage, adapter and grading cohorts can be reviewed
against one shape. The operator can veto a recommendation before live rollout.

| Open decision | Planner recommendation pending operator confirmation | Rationale |
| --- | --- | --- |
| Transport (section 2) | Use dependency-free HTTP through the platform `fetch` API. | The observation package has an exact dependency allowlist (`hono`, `kysely`, `pg`, `zod`). HTTP keeps the adapter behind the port without adding an SDK or expanding that list. |
| Privacy classification (section 4.1) | Use a separate Langfuse projection policy declaring sensitivity for analysis, plan, brief and assessment bodies. Classify other artifact kinds as restricted. | The Assay export policy describes an offline dataset and does not yet declare sensitivity kinds for these bodies. A separate policy makes the external disclosure choice explicit. The projection encoder includes public evidence content, withholds unclassified references, and gates raw build output, raw test output and repository content on explicit policy flags. |
| Observation granularity (section 4.2) | Create one observation per selected occurrence/question package. | Each question has its own wording, version, input recipe and score name. Including question identity in the mapping key prevents two questions sharing an evidence set from colliding. |
| Existing Oakridge human labels (section 6) | Report `authority.review_decision` and `authority.collaboration_thread` labels as a separate comparison series, apart from blinded annotation labels. | Existing operator feedback is valuable context, but its collection path and visibility differ from a held-out annotation sample. A separate series preserves both without implying that the historical labels were blinded. |
| Sync state location (section 7) | Keep `queued`, `pending`, `timed_out`, `unmatched` and `stale` on a distinct Langfuse mapping/sync record; retain `completed` and `failed` there as sync outcomes. | The local `evaluation_execution.status` remains `running`, `completed` or `failed`. An unmatched inbound score may have no local execution row, so putting that state on an execution would misrepresent the source of truth. |

## Contract pinned by this cohort

`EvaluationBackend.project` accepts a named input containing the local execution,
captured evidence package, question definition and pinned question text, source
revision context, projection policy and projection version. It returns the
external trace, observation, score and annotation queue item IDs as a `Result`.
`fetch` reads inbound scores and annotation outcomes for an authenticated mapping;
`reconcile` repairs a known mapping when an API response was missed or a later
read resolves eventual consistency. Each failure carries operation, entity ID
and detail. With no adapter configured, local capture, grading and reads continue;
the no-Langfuse backend reports external calls as disabled domain errors.

The trace metadata contains producer, namespace, run and unit IDs, artifact kind,
revision ID and digest, optional logical item ID, occurrence ID, extractor
version, question ID and version, and privacy classification. The observation
input carries question wording, its input recipe and policy-scoped evidence;
the output carries the local execution state and outcome metadata. The score
name is `question_id@question_version`.

The evidence-set digest is the `canonical-json/v1` digest of
`{evidence_refs, is_incomplete, incompleteness_reason}`, matching the
[Assay export contract](observation-assay-export.md). `evidence_set_id` does not
substitute for that digest. The mapping key is the `canonical-json/v1` digest of
the ordered tuple `(occurrence_id, evidence_set_digest, question_id,
question_version, projection_version)`. Repeating the same projection is
idempotent; changing evidence content or the selected question creates a new
target identity.

`projection_version` describes only the Langfuse trace/observation projection
shape: field placement, evidence encoding and score naming. It is independent
of `extractor_version`, already pinned in `occurrence_id`, and of
`question_version`. Bump it only when a changed projection shape would make new
observations structurally incomparable with old ones. A bump creates new mapping
keys and targets. Existing mappings remain readable and are never rewritten to
the new shape.

## Pilot catalogue and evidence boundary

The three `v1` definitions live in `observation/src/grading/catalogue/langfuse-pilot.ts`.
Their pinned recipes live in `observation/src/langfuse/evidence-recipe.ts`.
Each projected reference carries only its role, source ref, digest and deep link;
whole artifact bodies, raw code and specification text remain in the observation
store. An undeclared role or a missing reference address is rejected. An
assessment may have zero linked finding references, which is a meaningful
coverage miss rather than missing evidence.

| Question | Selected item | Pinned input | Pinned output | Answer |
| --- | --- | --- | --- | --- |
| `analysis.finding_relevance/v1` | `analysis.findings` `finding` | Original requested change and relevant excerpt, each by source reference | One analysis finding reference | Choice: relevant, irrelevant or unclear/insufficient evidence |
| `brief.source_fidelity/v1` | `brief.criteria` `criterion` | The identified plan criterion | Its brief criterion with the same cohort criterion id | Choice: faithful, changed meaning or unclear/insufficient evidence |
| `assessment.coverage/v1` | `brief.criteria` `criterion` | One brief criterion | Assessment finding references, possibly empty | Boolean: at least one explicit `assesses` link |

For fidelity, the brief criterion's `derived_from` link uses the unchanged plan
cohort criterion id; rewritten text preserves that identity. For coverage, the
catalogue creates an `assesses` link only when the assessment finding has a
string `criterion_id`. A finding with no id has no link and is not itself a
coverage miss. Only a brief criterion with no linked assessment finding is a
miss.

`observation/src/langfuse/classification.ts` declares the top-level body field
kinds for analysis, plan, brief and assessment. A field absent from its artifact
map is `unclassified_content` and is withheld; only fields declared `public`
pass through a whole-body projection. This policy is separate from the frozen
Assay export redaction policy. An explicit recipe can name bounded source
references for grading while leaving source content in the observation store.

The service coverage checker reads the selected brief criterion and the
catalogue's assessment finding links as a small local link view. It answers
`false` when no `assesses` link points to the criterion, including when the
assessment has no findings. Unlinked integration findings do not add misses.
The Jev Score encoder retains a fractional expected rubric level, the full
level distribution and probabilities in a structured answer. The stored
`normalized_score` and decision policy fields remain null until a separately
versioned decision policy is applied.
