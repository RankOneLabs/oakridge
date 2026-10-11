# Operator PWA parity evidence

The comparison source is `main` at the start of the c10 parity gate. Each entry
below quotes an assertion from that source and the corresponding assertion in
this branch. **Translated** means the same operator behavior is checked through
the generated read model. **Relaxed** means coverage is weaker. **Unportable**
means the old behavior has no equivalent contract or surface in this branch;
the original assertion is retained here for review rather than silently
deleted. A passing test does not resolve an unportable entry.

This branch has mapped and tested 20 of the 48 `main` PWA test files. The remaining 28 are
listed below as an explicit coverage gap; this is not a completed parity gate.

## `kbbl/core/pwa/oakridge/__tests__/artifact-review.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replacement | `expect(screen.getByTestId("or-artifact-type").textContent).toBe("spec_v2");` | `expect(screen.getByTestId("or-artifact-review").textContent).toContain("analysis");` | The generated projection identifies the output by `output_key`; the old artifact `type_id` claim is retired. The new heading identifies a different but relevant artifact identity. |
| Unportable | `expect(screen.getByTestId("or-artifact-stage").textContent).toBe("spec");` | No equivalent assertion. | The output slot and revision do not carry a producing stage; the scope has a key and label, but asserting either would claim a different fact. |
| Translated | `expect(body.textContent).toContain("Spec body");` | `expect(screen.getByTestId("operator-typed-value").textContent).toContain("Spec body");` | The revision body is a generated `OperatorCheckedValue` rendered by the typed viewer. |
| Unportable | `expect(validation.textContent).toContain("true");` | No equivalent assertion. | Validation metadata is absent from `OperatorArtifactRevisionRecord`; validation belongs to the authority before publication. |
| Unportable | `expect(status.textContent).toBe("approved");` | No equivalent assertion. | Current revision records do not have an `approved` status field. |
| Unportable | `expect(screen.getByTestId("or-artifact-detail").getAttribute("data-review-layout")).toBe("report");` | No equivalent assertion. | Review descriptors and their layout field are not projected. The viewer is selected from the checked body schema. |
| Unportable | `expect(screen.getByTestId("or-decision-approve").textContent).toContain("Approve discrepancy report");` | No equivalent assertion. | Action labels are now the pinned command label, not an artifact-local override. |
| Unportable | `expect(sections.map((section) => section.getAttribute("data-artifact-section"))).toEqual(["summary", "details"]);` | No equivalent assertion. | Descriptor sections are absent; checked schemas determine field order. |
| Translated | `expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();` | `expect(screen.getByTestId("or-gate-actions").textContent).toContain("Submit Approve");` | The current action is a command on the scope, whose observed target identifies the revision. |
| Translated | `expect(screen.queryByTestId("or-artifact-gate-actions")).toBeNull();` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | Switching to a revision outside the observed command target still hides the action. |
| Unportable | `expect(fetchSpy.mock.calls.some(([input]) => String(input).includes("/runs/run-1/gates"))).toBe(true);` | No equivalent assertion. | Current scope projections include commands and targets; there is no run-scoped gate fetch. |
| Unportable | `expect(await screen.findByText("Scope")).toBeTruthy(); expect(screen.getByText("migration")).toBeTruthy(); expect(screen.queryByTestId("or-plan-cohorts")).toBeNull();` | No equivalent assertion in this file. | The old fixture is an untyped plan body and descriptor. A checked `plan_body` and schema must drive the current `PlanViewer`; its coverage belongs to the viewer suite. |
| **Relaxed** | `expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();` | `expect(screen.getByRole("status").textContent).toContain("unavailable in the current scope projection");` | The current review consumes the loaded scope projection. This checks missing-revision handling but no longer proves an artifact-fetch error is shown; scope-load failures are covered separately. |
| Replacement | `expect(screen.queryByText("← Back")).toBeNull();` | `expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();` | Review navigation is now an explicit overview action on the review shell. The old absence claim is deliberately retired. |

The first suite has 6 passing tests, including a UI edit submission and a check
that the review follows the new revision. The old
claims below are closed as explicit replacement-surface decisions, not as
translations. An authority-owned fact is not inferred from a missing revision
field, and a retired v15 endpoint is not restored merely to satisfy a test.

| Old claim | Replacement surface decision | Coverage consequence |
| --- | --- | --- |
| Producing stage | The scope projection's `scope_key` and label identify the owning scope; the output slot's `output_key` identifies the artifact. `RunWorkspace` shows both. | The old `producing_stage` field is retired; the exact stage-name assertion remains a recorded loss. |
| Validation metadata | The compiler checks the publication against the pinned schema before the revision reaches the review projection. The UI receives `OperatorCheckedValue`. | The old `validation.valid` display is retired. Compiler validation is authoritative, but this is a moved claim, not a PWA translation. |
| Revision `approved` status | The current scope state and available command list express review progress; `GateDecisionActions` tests target-specific actions. | The old artifact-local status chip is retired. Its exact assertion is not claimed as preserved. |
| Descriptor layout and sections | The checked body schema selects the viewer and field order. `PlanViewer` and `OperatorTypedValue` render that structure. | `data-review-layout` and descriptor-section attributes are retired; the old presentation contract is not asserted. |
| Artifact-local action label | The pinned command label is displayed by `GateDecisionActions`. | The artifact-local override is retired; the new label is a different authored source. |
| Run-scoped gate fetch | The scope projection includes commands and observed revision targets; the target assertion above verifies action visibility. | No separate gate fetch occurs. Fetch mechanics changed; target-specific action behavior is covered. |
| Untyped plan body | `PlanViewer` consumes a checked `plan_body`; its own suite checks scope, cohort order and graph. | Untyped plan tolerance is retired; malformed bodies are rejected before publication. |

## `kbbl/core/pwa/oakridge/lib/run-attention.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);` | `expect([...counts]).toEqual([["run-a", 2], ["run-b", 1]]);` | Inputs now come from the generated inbox command variant through `makeInboxCommand`; the run grouping claim is identical. |
| Translated | `expect(counts.get("run-a")).toBeUndefined();` | `expect(counts.get("run-a")).toBeUndefined();` | A generated `wait` item with reason `handoff_downstream` replaces the former blocked review item. The selector was corrected to exclude waits. |
| Translated | `expect(counts.get("run-a")).toBe(1);` | `expect(counts.get("run-a")).toBe(1);` | The generated `diagnostic` variant replaces the former `pull_request_mismatch` item; both require operator attention. |
| Unportable | `expect([cohorts.get(selectReviewCohortKey(gate)), cohorts.get(selectReviewCohortKey(admission))]).toEqual(["gate stage", "admission stage"]);` | No equivalent assertion. | The generated inbox does not project `stage_instance_id`, `unit_id`, or the former review cohort key; scope IDs replace those identities. |

## `kbbl/core/pwa/oakridge/lib/decision-queue.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replaced, parity restored | `expect(selectStableDecisionQueue([live("a"), live("b"), live("c")], [gate("b"), gate("c")])).toEqual([{ kind: "settled", item: gate("a") }, live("b"), live("c")]);` | `expect(selectStableOperatorDecisionQueue([a, b, c].map((item) => ({ kind: "live", item })), [b, c])).toEqual([{ kind: "settled", item: a }, { kind: "live", item: b }, { kind: "live", item: c }]);` | `ReviewInboxView` now renders retained settled rows as disabled. Generated inbox commands come from `makeInboxCommand`; the row-position claim is preserved. |
| Replaced, parity restored | `expect(selectStableDecisionQueue([live("a"), live("b")], [gate("assessment"), gate("a"), gate("b")])).toEqual([live("a"), live("b"), live("assessment")]);` | `expect(selectStableOperatorDecisionQueue([a, b].map((item) => ({ kind: "live", item })), [assessment, a, b])).toEqual([{ kind: "live", item: a }, { kind: "live", item: b }, { kind: "live", item: assessment }]);` | New generated inbox commands append after retained rows even when the server lists them first. |
| Translated | `expect(selectStableDecisionQueue([], [gate("b"), gate("a")])).toEqual([live("b"), live("a")]);` | `expect(selectActionableScopes(scopes).map((scope) => scope.scope_id)).toEqual(["first", "last"]);` | Initial display order still follows the projection order; idle scopes are omitted. |

## `kbbl/core/pwa/oakridge/lib/status-tone.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(selectStatusTone(status as StatusToneSource)).toBe(tone);` | `for (const [status, tone] of cases) expect(selectStatusTone(status)).toBe(tone);` | The former hand-written status unions are gone. The new table retains every distinct old status and expected tone, including `pending`, `cancelled`, and `closed`; the selector was updated to preserve those colors. |
| Translated | `expect(selectStatusTone("superseded" as StatusToneSource)).toBe("muted");` | `expect(selectStatusTone("superseded")).toBe("muted");` | The generated selector accepts strings; unknown statuses still display muted. |

## `kbbl/core/pwa/oakridge/client.failure-detail.test.ts`

No changed assertions. All four tests retain their original text; `client.ts`
still re-exports `selectFailureDetail` from its current implementation module.
The test inputs are HTTP failure payloads, not hand-written read-model fixtures.

## `kbbl/core/pwa/oakridge/styling-criteria.test.ts`

No changed assertions. All four source-scanning tests retain their original
text. This suite has no read-model fixture.

## `kbbl/core/pwa/oakridge/components/molecules/RoleModelPicker.test.tsx`

No changed assertions. Both tests and the runtime descriptor fixture retain their
original text. The descriptor fixture comes from the runtime catalog constants,
not a hand-written Oakridge read model.

## `kbbl/core/pwa/oakridge/client.project-update.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(result).toEqual({ ok: true, value: expect.objectContaining({ id: projectId, repo_dir: "/code/rol/scout" }) });` | `expect(await updateOperatorProject(project.id, makeProjectDraft())).toEqual(project);` | The generated `OperatorProjectView` fixture comes from `makeProject`; current client calls return the value directly. Equality checks more projected fields than the old partial match. |
| Translated | `expect(result).toEqual({ ok: false, error: { operation: "update project", path: \`/projects/${projectId}\`, detail: "repository not found" } });` | `await expect(updateOperatorProject("project-1", makeProjectDraft())).rejects.toEqual(new OakridgeHttpError(400, "repository not found"));` | HTTP failures now throw `OakridgeHttpError`. The detail is preserved; the old operation/path object is not part of the current client contract. |
| **Relaxed** | `expect(result).toEqual({ ok: false, error: { operation: "update project", path: \`/projects/${projectId}\`, detail: expect.any(String) } });` | `await expect(updateOperatorProject("project-1", makeProjectDraft())).rejects.toBeInstanceOf(SyntaxError);` | The current `request` helper lets malformed successful JSON reject without operation/path context. The test detects failure but no longer proves contextual error reporting. |

## `kbbl/core/pwa/oakridge/lib/plan-graph.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(layout.edges.map((edge) => \`${edge.from}->${edge.to}\`)).toEqual(["core->api", "core->ui", "api->ui"]);` | Same assertion. | The generated `plan_body` fixture uses the checked value and schema field order from the shipped development bundle. |
| Translated | `expect(top("core") < top("api") && top("api") < top("ui")).toBe(true);` | `expect(left("core") < left("api") && left("api") < left("ui")).toBe(true);` | The restored graph is horizontal; the same dependency ordering is asserted on its x axis. |
| Translated | `expect(isInside).toBe(true);` with `PLAN_GRAPH_NODE.width` and `.height` | `expect(isInside).toBe(true);` with the rendered SVG rectangle's `180` by `70` dimensions | The old layout constant is gone; the canvas containment check uses the current node dimensions. |
| Translated | `expect([orphan.nodes.length, orphan.edges.length]).toEqual([1, 0]);` | `expect([graph.nodes.length, graph.edges.length]).toEqual([1, 0]);` | An unknown dependency still creates no edge. |

## `kbbl/core/pwa/oakridge/components/molecules/PlanViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(screen.getAllByTestId("or-plan-graph-node")).toHaveLength(2);` | Same assertion. | The fixture is now a generated checked plan value with its schema. |
| Translated | `expect(screen.getAllByTestId("or-plan-cohort").map((card) => card.getAttribute("data-cohort-id"))).toEqual(["core", "api"]);` | `expect(screen.getAllByTestId("or-plan-cohort").map((card) => card.querySelector("strong")?.textContent)).toEqual(["core: Core", "api: API"]);` | Cards no longer expose `data-cohort-id`; the visible ID and title retain the same order, restored through `dependency_order`. |
| Translated | `expect(selectedCardId()).toBe("api");` | `expect(screen.getAllByTestId("or-plan-cohort")[1]?.getAttribute("aria-current")).toBe("true");` | The selected card is now identified by `aria-current` rather than a ring class. |
| Unportable | `expect(selectedCardId()).toBe("core");` after clicking the dependency's `After` chip | No equivalent assertion. | The current card renders `After core` as text, without a dependency navigation control. |
| Unportable | `expect(within(card).getByText("src/core.ts")).toBeTruthy();` after clicking `Details` | No equivalent assertion. | Cohort details are always displayed and the current card has no fold control. |
| Unportable | `expect(within(screen.getByTestId("or-risk-card")).getByText("No mitigation given.")).toBeTruthy();` | No equivalent assertion. | The shipped checked `risk` schema requires a mitigation string; a bare-string risk cannot be projected. |
| Unportable | `expect(screen.getByRole("alert").textContent).toContain("scope: expected an object");` | No equivalent assertion. | The checked value has already been validated by the compiler; the viewer has no untyped-body contract error surface. |

## `kbbl/core/pwa/oakridge/lib/plan.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(parsePlan(body).ok).toBe(true);` | No PWA assertion. | The compiler checks the raw plan before projecting `OperatorCheckedValue`; the PWA has no `parsePlan` ingress. This moved validation is not counted as a passing PWA test. |
| Unportable | `expect(parsed({ ...body, risks: ["Pin drift"] }).risks).toEqual([{ description: "Pin drift", mitigation: null }]);` | No equivalent assertion. | The pinned `risk` schema requires a mitigation string; a bare string cannot be checked and projected. |
| Unportable | `expect(parsed({ ...body, cohorts: [withoutDescription] }).cohorts[0]?.description).toBeNull();` | No equivalent assertion. | The checked `plan_cohort` has an explicit optional `description` field. The old missing-property parser fallback is outside the PWA contract. |
| Unportable | `expect(result.ok ? null : result.error.field).toBe("cohorts[1].files_in_scope");` | No equivalent assertion. | Validation errors are returned by the compiler before publication; the checked viewer never receives an invalid `files_in_scope`. |
| Unportable | `expect(parsePlan({ ...body, scope: { include: ["core"] } }).ok).toBe(false);` | No equivalent assertion. | The compiler rejects a scope that does not match `plan_scope`; the PWA consumes only checked values. |
| Translated | `expect(selectOrderedCohorts(parsed(body)).map((entry) => entry.id)).toEqual(["core", "api"]);` | `expect(ids(["core", "api"])).toEqual(["core", "api"]);` | The `makePlanGraphFixture` checked body retains the same dependency order and body order. |
| Translated | `expect(selectOrderedCohorts(parsed({ ...body, dependency_order: ["api"] })).map((entry) => entry.id)).toEqual(["api", "core"]);` | `expect(ids(["api"])).toEqual(["api", "core"]);` | An omitted cohort still follows the listed cohort. |
| Translated | `expect(selectOrderedCohorts(parsed({ ...body, dependency_order: ["core", "core", "api"] })).map((entry) => entry.id)).toEqual(["core", "api"]);` | `expect(ids(["core", "core", "api"])).toEqual(["core", "api"]);` | Repeated order keys do not duplicate cohort cards. |

## `kbbl/core/pwa/oakridge/lib/pr-summary.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(parsed.ok && parsed.value.base_branch).toBe("epic/metrics-update");` | No equivalent assertion. | The current pinned `pr_body` has no `base_branch`; branch policy belongs to the scope's repository preparation and forge observation. |
| Translated | `expect(parsed.ok && parsed.value.review_status).toBeNull();` | `expect(selectFieldText(body, schemas, "review_status")).toBeNull();` | The checked optional status is null in the factory fixture, as in the original body. |
| Unportable | `expect(parsed.ok ? null : parsed.error.field).toBe("branch");` | No equivalent assertion. | Missing required fields fail compiler validation before the PWA receives a checked revision. |
| Replacement | `expect(selectPullRequestLabel(body.pr_url)).toBe("RankOneLabs/assay #50");` | `expect(screen.getByRole("link", { name: "Open pull request" }).getAttribute("href")).toBe("https://github.com/RankOneLabs/assay/pull/50");` | The current viewer uses an explicit link label. The destination remains exact, while the old abbreviated text is retired. |
| Replacement | `expect(selectPullRequestLabel("https://gitlab.com/a/b/-/merge_requests/1")).toBeNull();` | `expect(selectHttpUrl("https://gitlab.com/a/b/-/merge_requests/1")).toBe("https://gitlab.com/a/b/-/merge_requests/1");` | Any safe HTTP URL is now linked. The old GitHub-only label rule is deliberately broadened. |
| Translated | `expect(isWebUrl("javascript:alert(1)")).toBe(false);` | `expect(selectHttpUrl("javascript:alert(1)")).toBeNull();` | An unsafe scheme still cannot become a link. |

## `kbbl/core/pwa/oakridge/hooks/useOakridgeRunEventStream.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(EventSourceStub.instances).toHaveLength(1);` | `expect(EventSourceStub.instances.filter((source) => source.readyState !== EventSourceStub.CLOSED)).toHaveLength(1);` | The shared live connection may reconnect as subscriptions mount; this only proves that one physical source stays active, rather than that only one was created. The event fixture now comes from `makeRunEvent` in the shared read-model factory. |
| Replacement | `expect(received.map((event) => [event.sequence, event.replayed])).toEqual([["7", true], ["8", false]]);` | `expect(received.map((event) => event.transition_id)).toEqual(["transition-8"]); expect(invalidations).toHaveBeenCalledWith({ queryKey: queryKeys.run("run-one") });` | The generated authority event has a transition ID and replay metadata is envelope-only. Replayed frames refresh the query but are withheld from live notification subscribers; live frames are delivered. The old callback contract that delivered replayed frames is explicitly retired. |

## `kbbl/core/pwa/oakridge/lib/run-notifications.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replacement | `expect(selectRunFrameNotification(frame(false))).toEqual({ kind: "info", message: "Optional attention: Output published · build · c5", href: "#oakridge/run/run%2Fone" });` | `expect(selectEventNotification(operatorEvent({ run_id: "run/one" }))?.href).toBe("#oakridge/run/run%2Fone/scope/scope-one");` and `expect(selectEventNotification(operatorEvent())).toEqual({ kind: "info", message: "spec_analysis: Awaiting work or review", href: "#oakridge/run/run-one/scope/scope-one" });` | Current events identify a scope transition, not a v15 slot-release event. The notification still links the relevant surface and escapes run IDs, but its route and message come from the generated scope attention metadata. The old exact message and run-only link are retired. |
| Translated, moved to hook test | `expect(selectRunFrameNotification(frame(true))).toBeNull();` | `expect(received.map((event) => event.transition_id)).toEqual(["transition-8"]);` after replay and live frames are emitted | The event-stream hook now withholds replayed frames from notification subscribers before the selector runs. The suppression claim is preserved at the stream boundary rather than in the pure notification selector. |

## `kbbl/core/pwa/oakridge/components/molecules/SpecAnalysisViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect([within(blockers).queryByText("Schema conflict"), within(blockers).queryByText("Needs upstream API")]).not.toContain(null);` | `expect(within(screen.getByTestId("or-spec-findings")).getByText("Schema conflict")).toBeTruthy(); expect(within(screen.getByTestId("or-spec-requirements")).getByText("Needs upstream API")).toBeTruthy();` | Both checked values appear, but the current viewer has no combined blocker callout. The alerting and grouping claim is lost. |
| Translated | `expect(within(screen.getByTestId("or-risk-card")).getByText("Backfill in batches")).toBeTruthy();` | `expect(within(screen.getByTestId("or-risk-card")).getByText("Mitigation: Backfill in batches")).toBeTruthy();` | The risk's mitigation remains visible; the checked `risk` schema and record are built by `makeSpecAnalysisFixture`. |
| Translated | `expect(screen.getAllByText("Schema conflict")).toHaveLength(1);` | Same assertion. | The checked finding is rendered once in its section; it is no longer duplicated in a blocker callout. |
| Unportable | `expect(screen.getByTestId("or-spec-no-blockers")).toBeTruthy();` | No equivalent assertion. | The current viewer has no empty-blocker state or callout. Empty checked lists show empty sections instead; that does not communicate the old explicit “nothing blocking” status. |
| **Relaxed** | `expect(screen.queryByText("Brief §2")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /1 source/ })); expect(screen.getByText("Brief §2")).toBeTruthy();` | `expect(within(screen.getByTestId("or-spec-sources")).getByText("Brief §2")).toBeTruthy();` | The source survives the checked projection, but the count and disclosure toggle are gone. The new assertion only proves visibility. |
| Unportable | `expect(screen.getByRole("alert").textContent).toContain("does not match the registered contract");` | No equivalent PWA assertion. | The compiler validates `analysis_body` before the PWA receives `OperatorCheckedValue`; the current viewer has no raw invalid-body error surface. |

## `kbbl/core/pwa/oakridge/components/molecules/BuildBriefViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(screen.queryByRole("button", { name: "Edit goal" })).toBeNull();` | No equivalent viewer assertion. | The read-only viewer no longer owns edit mode. `ArtifactReview` now owns the **Edit artifact** control; its UI edit submission is tested in `artifact-review.test.tsx`. The original “before toggle” state is retired. |
| Unportable | `expect(screen.queryByRole("button", { name: "Edit brief" })).toBeNull();` | No equivalent viewer assertion. | Edit availability comes from the scope's `edit_${output_key}` command and revision capability at the review shell, not an `edit.enabled` prop on this viewer. The original disabled-prop claim is retired. |
| **Relaxed** | `expect(onEdit).toHaveBeenCalledWith("/goal", "Make the brief reviewable.", "Make every brief reviewable.");` | `expect(screen.getByText("Make the brief reviewable.")).toBeTruthy();` and the existing `artifact-review.test.tsx` checks the edit command's `prev_value` and changed checked `body`. | The goal is visible and a checked atom can be submitted through the review UI, but the old RFC-6901 callback contract is gone. This suite does not prove a goal-specific edit command. |
| **Relaxed** | `expect(onEdit).toHaveBeenNthCalledWith(1, "/files_in_scope/0", "kbbl/core/pwa/oakridge", "kbbl/core/pwa/oakridge/viewers");` | `expect([file?.value, rationale?.value]).toEqual(["kbbl/core/pwa/oakridge", "It is proven."]);` and the replacement-value assertion below | The shared checked-text editor finds and replaces the nested file atom; it no longer emits the old pointer callback. |
| **Relaxed** | `expect(onEdit).toHaveBeenNthCalledWith(2, "/decisions_made/0/rationale", "It is proven.", "It preserves proven behavior.");` | `expect(selectCheckedTextFields(edited ?? fixture.body, fixture.schemas).filter((field) => field.label === file.label || field.label === rationale.label).map((field) => field.value)).toEqual(["kbbl/core/pwa/oakridge/viewers", "It preserves proven behavior."]);` | The checked value retains both nested edits and sibling fields; the command-level sequence and RFC-6901 callbacks are not asserted. The fixture is `makeBuildBriefFixture`. |

The new brief viewer suite also checks the title, file list and acceptance criteria from the checked body. These are supplemental assertions; they do not close the old edit-control claims.

## `kbbl/core/pwa/oakridge/components/molecules/BuildResultViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(screen.getByRole("heading", { name: "Assemble the API" })).toBeTruthy();` | No equivalent assertion. | The current `build_body` viewer receives no brief lookup or brief title. The summary remains visible, but it is a different field. |
| Unportable | `expect(within(screen.getByTestId("or-build-files-out-of-scope")).getByText("ci.yml")).toBeTruthy();` | No equivalent out-of-scope assertion. | The checked `build_body` lists changed files, while `brief_body` is a separate output; this viewer does not compare their file lists. |
| Unportable | `expect(within(screen.getByTestId("or-build-acceptance")).getByText("The golden fixture matches.")).toBeTruthy();` | No equivalent assertion. | Brief acceptance criteria are not part of `build_body` and the viewer has no cross-output lookup. |
| **Relaxed** | `expect(screen.getByRole("alert").textContent).toContain("Fixture table incomplete.");` | `expect(issues.getByText("Fixture table incomplete.")).toBeTruthy(); expect(issues.getByText("blocking")).toBeTruthy();` | The issue description and severity survive, but the current viewer does not raise a blocking issue as an accessible alert. |
| **Relaxed** | `expect([screen.getByTestId("or-build-brief-note").textContent?.includes("cm-api"), !!screen.queryByText("ci.yml")]).toEqual([true, true]);` | `expect(files.getByText("src/api.py")).toBeTruthy(); expect(files.getByText("ci.yml")).toBeTruthy();` | Changed files remain visible without a brief; the old missing-brief note and cohort label are gone. The body comes from `makeBuildResultFixture`. |

The new suite separately checks the builder's reported passed and failed counts. It does not imply a file-scope comparison.

## `kbbl/core/pwa/oakridge/components/molecules/AssessmentViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(attention.getByText("2.")).toBeTruthy();` | No equivalent assertion. | The current viewer has only `assessment_body`; it cannot align a finding with the position of its criterion in a separate brief. |
| Unportable | `expect(screen.queryByText("Snapshot test passes.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ })); expect(screen.getByText("Snapshot test passes.")).toBeTruthy();` | No equivalent disclosure assertion. | Checked findings are rendered directly with no met-criterion fold control. The old collapsed-by-default interaction is retired. |
| Unportable | `expect(screen.getByTestId("or-assessment-builder-tests").textContent).toContain("1409 passed");` | No equivalent builder-result assertion. | The current viewer receives only the assessment's own `test_evidence`, not a cross-output build result. The new suite asserts its independent `1274` count separately. |
| Translated | `expect(screen.getByTestId("or-assessment-verdict").textContent).toBe("Fail");` | `expect(screen.getByText("fail")).toBeTruthy();` | The checked `verdict` enum remains visible through `StatusBadge`; its casing and test ID changed. |
| Translated | `expect(within(screen.getByTestId("or-assessment-attention")).getByText("Every fixture exists.")).toBeTruthy();` | `expect(findings.getByText("Every fixture exists.")).toBeTruthy(); expect(findings.getByText("B, E, F and G are missing.")).toBeTruthy();` | The finding remains visible with its evidence from `makeAssessmentFixture` even though the current viewer has no brief lookup. |

## `kbbl/core/pwa/oakridge/client.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(parseOakridgeRunEventFrame(JSON.stringify({ ... continuation: null ... }))).toBeNull();` | No equivalent client assertion. | The generated `OperatorRunEvent` has a scope ID, decision and attention metadata, but no gate slot continuation. The old event variant and parser are retired. |
| Translated | `expect(fetch).toHaveBeenCalledWith("/oakridge/api/workflow_runs", expect.objectContaining({ headers: expect.objectContaining({ "Idempotency-Key": "launch-1" }) }));` | `expect(fetch).toHaveBeenCalledWith("/oakridge/api/runs", expect.objectContaining({ method: "POST", body: expect.stringContaining('"request_id":"launch-1"') }));` | The caller still owns the launch key; the pinned-run API carries it as `request_id` in the body rather than an HTTP header. `makeStartPinnedRunRequest` and `makeStartedRun` build both read-model fixtures. |
| Unportable | `await expect(fetchRun("run-1")).rejects.toThrow("oakridge /runs/run-1: parse repository key");` | No equivalent assertion. | `fetchOperatorRun` consumes a generated projection directly and does not run the v15 stage/unit transform or contextual repository-key parser. An invalid legacy run shape is outside this endpoint's contract. |
| Replacement | `await expect(fetchRunSessions("run-1")).resolves.toEqual([expect.objectContaining({ session_id: "sid-1", reason: "operator_retry" })]);` | `expect(result.executions[0]).toMatchObject({ worker_key: "builder", generation: 2 });` | The generated scope projection exposes authority executions. It does not expose the old session-attempt reason and session ID, so this is an execution-read test and the old claim remains a coverage loss. The response comes from `makeScopeView` and `makeExecutionView`. |
| Unportable | `await expect(fetchRunSessions("run-1")).rejects.toThrow("entry contained an unknown work order reason");` | No equivalent assertion. | The generated execution status has no v15 work-order reason parser. |
| Unportable | `await expect(fetchSessionRun("sid-unknown")).resolves.toBeNull();` | No equivalent assertion. | The session-to-run lookup endpoint is absent from the authority client; session association is adapter-local and the PWA receives scope execution locations. |
| Unportable | `await expect(fetchSessionRun("sid-1")).resolves.toEqual(expect.objectContaining({ run_id: "run-1", unit_id: "api" }));` | No equivalent assertion. | The v15 unit identity and reverse session lookup are retired. Generated scopes use `scope_id` and executions instead. |
| Unportable | `await expect(confirmFinalPullRequest("run-1", repositoryKey, { idempotency_key: "confirm-1" })).rejects.toThrow("response contained an unknown outcome");` | No equivalent assertion. | Final reconciliation is an evaluator decision over checked scope facts, not a PWA client endpoint or response parser. |

The current client suite also tests generated run and definition pagination, config fallback, and scope-command idempotency with shared factory values. These are additional current-contract tests, not replacements for the retired endpoint assertions above.

## `kbbl/core/pwa/oakridge/lib/launch-selection.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(next).toEqual({ runtime: "claude-code", model: "claude-opus-4-8", effort: undefined });` | `expect(next).toEqual(makeRuntimeSelection());` | `coerceRoleSelection` still drops a stale effort while preserving the model for both advertised and empty-model descriptors. The expected value and descriptors are built in the shared factory. |
| Translated | `expect(next.effort).toBe(effort);` | Same assertion. | Null and undefined still remain no-override values in both parameterized cases. |
| Translated | `expect(next.effort).toBe("high");` | Same assertion. | A valid selected effort survives when the default runtime differs. |
| Translated | `expect(next.effort).toBeUndefined();` after a stale model and effort | Same assertion. | A replaced descriptor still drops an effort it does not advertise. |
| Translated | `expect(next.runtime).toBe("claude-code");` | Same assertion. | An untouched selection still follows the default runtime. |
| Translated | `expect(next.effort).toBeUndefined();` after a runtime change | Same assertion. | The effort from the previous runtime is cleared. |

## Remaining `main` suite gap

The following original files are not ported. A similarly named current test, where one exists, does not close the original assertions. These are open coverage gaps, not passing parity claims. The original file and its tests remain available in `main` for the next per-assertion diff.

| Original file | Original tests | Why no assertion-preserving port is present |
| --- | ---: | --- |
| `__tests__/GateDecisionActions.test.tsx` | 5 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/ReviewInboxView.test.tsx` | 11 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/oakridge.test.tsx` | 28 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/run-pane-bodies.test.tsx` | 12 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/run-session-removal.test.tsx` | 4 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/run-workspace.test.tsx` | 24 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/workflowdefs.test.tsx` | 15 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `components/molecules/ExpandableText.test.tsx` | 2 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `components/organisms/BindingEditor.test.tsx` | 6 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/assessment.test.ts` | 13 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/brief-notes.test.ts` | 15 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/build-brief.test.ts` | 2 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/build-result.test.ts` | 8 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/cohort-artifact.test.ts` | 13 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/launch-config.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/request-identity.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-accent.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-activity.test.ts` | 4 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-overview.test.ts` | 32 | The old stage/gate/attempt overview API was replaced by scope projections; its gate and sidebar claims need separate equivalents. |
| `lib/run-session-availability.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-sessions.test.ts` | 14 | The old work-order attempt and health model differs from the generated session projection; no assertion-preserving mapping has been established. |
| `lib/run-workspace-restore.test.ts` | 22 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-workspace-storage.test.ts` | 15 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-workspace.test.ts` | 25 | The old run-workspace selector uses v15 stages and units; the current scope workspace exposes a different data model. |
| `lib/spec-analysis.test.ts` | 11 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/stage-unit-params.test.ts` | 4 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/workflow-definition-form.test.ts` | 2 | The old form uses handwritten workflow definitions; the current form consumes pinned generated bundle schemas. |
| `repository-inputs.test.ts` | 6 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |

This register covers 28 files and 313 named test declarations as previously counted; parameterized cases may expand further. The ported plan, PR-summary, viewer and client suites also record source declarations that cannot run on checked projections. None is silently counted as passing.

## Surface checklist

The current captures come from the production PWA bundle through stub kbbl and stub forge against the production Oakridge composition. The `main` captures are from local `main` commit `f3b3ffca43e43672ff2f58ab797d65c7532aaed8`. Its artifact-review and definition-editor images are the archived `c4-review-authoring/review-desktop-*` and `authoring-desktop-*` captures; the other four rows were rendered from that commit's original React components in a temporary Vite harness with representative stub responses and captured at 1440 × 900 in both themes. The harness supplied one v15 run with two of four stages complete, one current session, one approval gate and one release; one actionable `artifact_gate` inbox item; one artifact with an open thread and two messages; and one v15 workflow definition. The temporary source tree was removed after capture. These pairs show surface changes; their fixtures are representative, not an assertion that the two systems share the same backend state.

| Surface | `main` light | `main` dark | Current light | Current dark | Result |
| --- | --- | --- | --- | --- | --- |
| Run overview | [light](parity-screenshots/main-run-overview-light.png) | [dark](parity-screenshots/main-run-overview-dark.png) | [light](parity-screenshots/run-overview-light.png) | [dark](parity-screenshots/run-overview-dark.png) | Main showed stage progress, session and gates; current shows scope progress. |
| Artifact review | [light](parity-screenshots/main-artifact-review-light.png) | [dark](parity-screenshots/main-artifact-review-dark.png) | [light](parity-screenshots/artifact-review-light.png) | [dark](parity-screenshots/artifact-review-dark.png) | Current review exposes a checked-value edit control; old revision metadata differs. |
| Artifact discussion | [light](parity-screenshots/main-artifact-discussion-light.png) | [dark](parity-screenshots/main-artifact-discussion-dark.png) | [light](parity-screenshots/artifact-discussion-light.png) | [dark](parity-screenshots/artifact-discussion-dark.png) | Both show a revision discussion; current ping resumes the ended stub session. |
| Review inbox | [light](parity-screenshots/main-review-inbox-light.png) | [dark](parity-screenshots/main-review-inbox-dark.png) | [light](parity-screenshots/review-inbox-light.png) | [dark](parity-screenshots/review-inbox-dark.png) | Current generated inbox uses scope commands and now retains settled row position. |
| Definition list | [light](parity-screenshots/main-definitions-light.png) | [dark](parity-screenshots/main-definitions-dark.png) | [light](parity-screenshots/definitions-light.png) | [dark](parity-screenshots/definitions-dark.png) | Old workflow graph and current pinned-definition catalog are different models. |
| Definition editor | [light](parity-screenshots/main-definition-editor-light.png) | [dark](parity-screenshots/main-definition-editor-dark.png) | [light](parity-screenshots/definition-editor-light.png) | [dark](parity-screenshots/definition-editor-dark.png) | Current editor authors the pinned development bundle. |

The edit-then-ping test checks that the edited revision has a null `execution_id` and points back to the agent revision. It clicks the review surface's **Edit artifact** control, changes the checked `summary` atom and saves through the PWA command hook. It then creates a discussion thread, sends a reply with Ping agent selected, and checks `delivered`, one resume of the already completed stub session, and the exact input received by stub kbbl.
