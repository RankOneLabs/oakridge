# Operator PWA parity evidence

The comparison source is `main` at the start of the c10 parity gate. Each entry
below quotes an assertion from that source and the corresponding assertion in
this branch. **Translated** means the same operator behavior is checked through
the generated read model. **Relaxed** means coverage is weaker. **Unportable**
means the old behavior has no equivalent contract or surface in this branch;
the original assertion is retained here for review rather than silently
deleted. A passing test does not resolve an unportable entry.

This branch has mapped and tested 41 of the 48 `main` PWA test files. The remaining 7 are
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
| Translated | `expect([within(blockers).queryByText("Schema conflict"), within(blockers).queryByText("Needs upstream API")]).not.toContain(null);` | `expect(blockers.getByText("Schema conflict")).toBeTruthy(); expect(blockers.getByText("Needs upstream API")).toBeTruthy();` | The checked selector now restores one combined blocker callout for both source types. |
| Translated | `expect(within(screen.getByTestId("or-risk-card")).getByText("Backfill in batches")).toBeTruthy();` | `expect(within(screen.getByTestId("or-risk-card")).getByText("Mitigation: Backfill in batches")).toBeTruthy();` | The risk's mitigation remains visible; the checked `risk` schema and record are built by `makeSpecAnalysisFixture`. |
| Translated | `expect(screen.getAllByText("Schema conflict")).toHaveLength(1);` | Same assertion. | The checked finding is rendered once in its section; it is no longer duplicated in a blocker callout. |
| Translated | `expect(screen.getByTestId("or-spec-no-blockers")).toBeTruthy();` | Same assertion. | The checked selector restores the explicit no-blockers state when both lists are empty. |
| Translated | `expect(screen.queryByText("Brief §2")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /1 source/ })); expect(screen.getByText("Brief §2")).toBeTruthy();` | `expect(screen.queryByText("Brief §2")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /1 source/ })); expect(within(screen.getByTestId("or-spec-sources")).getByText("Brief §2")).toBeTruthy();` | The source count, collapsed default and reveal interaction are restored from the checked source list. |
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

The new suite separately checks the builder's reported passed and failed counts. It also verifies blocking issues render before less urgent issues through the checked-value selector. It does not imply a file-scope comparison.

## `kbbl/core/pwa/oakridge/components/molecules/AssessmentViewer.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(attention.getByText("2.")).toBeTruthy();` | No equivalent assertion. | The current viewer has only `assessment_body`; it cannot align a finding with the position of its criterion in a separate brief. |
| Translated | `expect(screen.queryByText("Snapshot test passes.")).toBeNull(); fireEvent.click(screen.getByRole("button", { name: /Show met criteria/ })); expect(screen.getByText("Snapshot test passes.")).toBeTruthy();` | Same assertion. | The checked assessment viewer now keeps met findings folded until the operator asks. |
| Unportable | `expect(screen.getByTestId("or-assessment-builder-tests").textContent).toContain("1409 passed");` | No equivalent builder-result assertion. | The current viewer receives only the assessment's own `test_evidence`, not a cross-output build result. The new suite asserts its independent `1274` count separately. |
| Unchanged | `expect(screen.getByTestId("or-assessment-verdict").textContent).toBe("Fail");` | Same assertion. | The checked verdict now retains the old visible capitalization and test ID while its raw enum still controls tone. |
| Translated | `expect(within(screen.getByTestId("or-assessment-attention")).getByText("Every fixture exists.")).toBeTruthy();` | `expect(findings.getByText("Every fixture exists.")).toBeTruthy(); expect(findings.getByText("B, E, F and G are missing.")).toBeTruthy();` | The finding remains visible with its evidence from `makeAssessmentFixture` without a brief lookup. |

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

## `kbbl/core/pwa/oakridge/lib/run-sessions.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(rows.map((row) => ({ id: row.attempt.work_order_id, is_current: row.is_current, of: row.attempt_count }))).toEqual([{ id: "work-1", is_current: true, of: 1 }]);` | No equivalent current-attempt assertion. | The authority projection exposes executions and generations, not v15 work-order attempts or an `is_current` marker. |
| Unportable | `expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);` when a newer attempt was abandoned | No equivalent assertion. | The generated execution status has `pending` or `terminal`, with no `abandoned` work-order state. |
| Unportable | `expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);` when all attempts completed | No equivalent assertion. | The selector returns all projected executions, without selecting a current work order. |
| Unportable | `expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);` across the DST fold | No equivalent assertion. | Generated `OperatorExecutionView` has a generation but no rendered `created_at` field. The old timestamp-order fallback is retired. |
| Unportable | `expect(currentWorkOrderIds(attempts)).toEqual(["work-2"]);` when all attempts were abandoned | No equivalent assertion. | Abandonment and current work-order selection are not in the generated projection. |
| Replacement | `expect(currentWorkOrderIds(attempts)).toEqual(["work-1", "work-2"]);` for separate units | `expect(rows.map((row) => [row.scope_id, row.execution.id])).toEqual([["scope-build", "execution-build"], ["scope-assess", "execution-assess"]]);` | Scope identity keeps executions distinct, but this does not assert v15 unit current-attempt selection. Both scopes and executions come from the shared factory. |
| Unportable | `expect(selectRunSessionRows(attempts).map((row) => \`${row.attempt.unit_id} ${row.attempt_number}/${row.attempt_count}\`)).toEqual(["api 1/2", "web 1/1", "api 2/2"]);` | No equivalent assertion. | The current sidebar shows executions by scope; it does not number attempts within v15 units. |
| Translated | `expect(selectRunSessionRows(attempts).map((row) => row.attempt.work_order_id)).toEqual(["work-1", "work-2"]);` | `expect(rows.map((row) => row.execution.id)).toEqual(["execution-1", "execution-2", "execution-3"]);` | The selector preserves server projection order within and across scopes; the identity changed from work order to execution. |
| Translated | `expect(selectRunSessionRows([])).toEqual([]);` | `expect(selectRunExecutions([makeScopeView(), makeScopeView({ scope_id: "scope-2" })])).toEqual([]);` | Scopes with no executions produce no sidebar rows. |
| Replacement | `expect(runUnitKeyOf(build)).not.toBe(runUnitKeyOf(assess)); expect(currentWorkOrderIds([build, assess])).toEqual(["work-1", "work-2"]);` | `expect(rows.map((row) => [row.scope_id, row.execution.id])).toEqual([["scope-build", "execution-build"], ["scope-assess", "execution-assess"]]);` | Generated scope IDs distinguish work in different scopes. The old stage-instance/unit composite key and current selection are retired. |
| Unportable | `expect(selectRunSessionsRead({ attempts: undefined, is_pending: true, is_error: false })).toEqual({ kind: "pending" });` | No equivalent selector assertion. | React Query owns the scope read state; `selectRunSessionsRead` was removed. |
| Unportable | `expect(selectRunSessionsRead({ attempts: undefined, is_pending: false, is_error: true })).toEqual({ kind: "unavailable" });` | No equivalent selector assertion. | Scope-read errors are handled by the query boundary, not a session-attempt read union. |
| Unportable | `expect(selectRunSessionsRead({ attempts: ATTEMPTS, is_pending: false, is_error: true })).toEqual({ kind: "loaded", attempts: ATTEMPTS });` | No equivalent selector assertion. | Stale-data retention is delegated to React Query and is not asserted by this pure execution selector. |
| Unportable | `expect(selectRunSessionsRead({ attempts: [], is_pending: false, is_error: false })).toEqual({ kind: "loaded", attempts: [] });` | No equivalent read-state assertion. | The current selector accepts already loaded scopes and returns an empty row list; it does not represent pending, error or loaded states. |

## `kbbl/core/pwa/oakridge/lib/workflow-definition-form.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(result).toEqual({ ok: false, error: { operation: "validate_workflow_definition", entityId: "new_workflow_definition", details: ["Name is required."] } });` | No equivalent name-validation assertion. | A pinned definition is compiled by the authority from `WorkflowAuthoring`. The current editor has no graph `name` field or `validateWorkflowDefinition` error result. The new suite separately checks that unknown stored authoring versions are rejected. |
| Replacement | `expect(validateWorkflowDefinition({ name: "workflow", stages: [], edges: [] })).toEqual({ ok: true, value: null });` | `expect(selectStoredAuthoring({ authoring })).toEqual(authoring); expect(selectCloneAuthoring(authoring).key).toBe("workflow-copy");` | Valid persisted authoring can be reopened and cloned, but an empty v15 stage graph is no longer a definition. The fixture comes from `makeWorkflowAuthoring`; the old empty-graph claim is retired. |

## `kbbl/core/pwa/oakridge/lib/launch-config.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(buildEpicProfile(" Full parity! ", "guarded", [{ key: "oakridge" as RepositoryKey, path: "/code/oakridge", forge_owner: "acme", forge_name: "oakridge", integration_branch: "main" }])).toEqual({ title: "Full parity!", slug: "full-parity", final_merge_policy: "guarded", repositories: [{ repository_key: "oakridge", repository_path: "/code/oakridge", integration_branch: "main", forge_repository: { provider: "github", owner: "acme", name: "oakridge" } }] });` | `expect(draft).toEqual({ name: "Full parity!", repo_dir: "/code/oakridge", forge_repository: { provider: "github", owner: "acme", name: "oakridge" }, integration_branch: "main" });` | The generated project draft preserves trimmed name, repository path, forge identity and branch. It no longer asserts a durable slug, multiple repositories or the old merge policy. `makeProjectFormValues` supplies the inputs. |
| Unportable | `expect(buildEpicProfile("!!!", "guarded", [])).toBeNull();` | No equivalent slug assertion. | The pinned project has a name and repo directory; the old epic slug is absent. Project validation belongs to the authority API. |
| Unportable | `expect(profile?.final_merge_policy).toBe("external_confirmation");` | No equivalent assertion. | The current pinned development bundle offers its own `final_merge_policy` variants, not the retired `external_confirmation` epic profile choice. |
| Translated | `expect(buildRunExecutionContext({ brief_notes: "Build it", base_branch: "epic/build-it", repositories: [{ key: "oakridge" as RepositoryKey, path: "/code/oakridge", integration_branch: "main" }], oakridge_url: "http://oakridge", planner: { runtime: "claude-code", model: "opus" }, worker: { runtime: "claude-code", model: "sonnet" } })).toEqual({ ok: true, value: expect.objectContaining({ planner_effort: null, worker_effort: null }) });` | `expect(input).toMatchObject({ sessions: { planner: { effort: null }, worker: { effort: null } } });` | Launch-wide role selections still write explicit null effort, now under the pinned root `sessions` value rather than v15 context fields. `makeRuntimeSelection` supplies both roles. |
| Unportable | `expect(buildRunExecutionContext({ brief_notes: "Build it", base_branch: "epic/build-it", repositories: [], oakridge_url: "http://oakridge", planner: { runtime: "claude-code", model: "opus" }, worker: { runtime: "claude-code", model: "sonnet" } })).toEqual({ ok: false, error: { operation: "build_run_execution_context", detail: "At least one repository with a worktree path is required." } });` | No equivalent PWA assertion. | The pinned root schema and compiler validate repository collections; the old context builder and its specific error result are gone. |

## `kbbl/core/pwa/oakridge/repository-inputs.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replacement | `expect(repositoryDraftFromProject({ id: projectId, name: "PAA dot DEV", repo_dir: "/repos/paa", created_at: "2026-08-12T00:00:00Z", forge_repository: { provider: "github", owner: "RankOneLabs", name: "paa_site" }, base_branch: "develop" }, { key: "repo", path: "", forge_owner: "", forge_name: "", integration_branch: "main" })).toEqual({ key: "paa-dot-dev", path: "/repos/paa", forge_owner: "RankOneLabs", forge_name: "paa_site", integration_branch: "develop" });` | `expect(JSON.parse(drafts.repositories!)[0]).toMatchObject({ key: "PAA dot DEV", preparation: { repository_path: "/repos/paa" }, forge: { owner: "RankOneLabs", name: "paa_site", build_base: "develop", final_base: "develop" } });` | The generated root repository input still receives path, forge identity and branch from `makeProject`. The old slug transformation is gone; the pinned repository key follows the project name. |
| Replacement | `expect(repositoryDraftFromProject({ id: projectId, name: "API", repo_dir: "/repos/api", created_at: "2026-08-12T00:00:00Z" }, { key: "old", path: "/old", forge_owner: "acme", forge_name: "api", integration_branch: "release" })).toMatchObject({ forge_owner: "acme", forge_name: "api", integration_branch: "release" });` | `expect(draft).toMatchObject({ forge_repository: { owner: "acme", name: "api" }, integration_branch: "release" });` | The project form retains explicit forge and branch values, but there is no v15 repository-draft merge with a partially populated project. `makeProjectFormValues` supplies the current form fixture. |
| **Relaxed** | `expect(validateRepositoryInputs([{ key: " api ", path: " /repos/api ", forge_owner: " acme ", forge_name: " api ", integration_branch: " main " }, { key: "web", path: "/repos/web", forge_owner: "acme", forge_name: "web", integration_branch: "main" }])).toEqual({ ok: true, repositories: [{ key: "api", path: "/repos/api", forge_owner: "acme", forge_name: "api", integration_branch: "main" }, { key: "web", path: "/repos/web", forge_owner: "acme", forge_name: "web", integration_branch: "main" }] });` | `expect(draft).toEqual({ name: "API", repo_dir: "/repos/api", forge_repository: { provider: "github", owner: "acme", name: "api" }, integration_branch: "main" });` | Whitespace normalization survives for one project. The old multi-repository normalization and keyed collection are not tested by this PWA selector. |
| Unportable | `expect(validateRepositoryInputs([{ key: "api", path: "/repos/one", forge_owner: "acme", forge_name: "one", integration_branch: "main" }, { key: "api", path: "/repos/two", forge_owner: "acme", forge_name: "two", integration_branch: "main" }])).toEqual({ ok: false, error: { operation: "validate_repository_inputs", repository: "api", detail: "Repository keys must be unique." } });` | No equivalent PWA assertion. | The project form stores one repository; pinned collection uniqueness is checked by the authority compiler. |
| Unportable | `expect(validateRepositoryInputs([{ key: "api", path: "repos/api", forge_owner: "acme", forge_name: "api", integration_branch: "main" }])).toEqual({ ok: false, error: { operation: "validate_repository_inputs", repository: 0, detail: "Repository paths must be absolute." } });` | No equivalent PWA assertion. | `selectProjectDraft` trims text but does not validate absolute paths; project creation and repository preparation enforce this later. The old contextual form error is lost. |
| Unportable | `expect(validateRepositoryInputs([{ key: "api", path: "/repos/api", forge_owner: "", forge_name: "api", integration_branch: "main" }])).toEqual({ ok: false, error: { operation: "validate_repository_inputs", repository: 0, detail: "Every repository needs a key, local path, GitHub owner/name, and integration branch." } });` | No equivalent PWA assertion. | Forge identity is optional on a project; a pinned run requiring it is checked against its root schema and preparation command. The old all-fields-required rule is retired. |

## `kbbl/core/pwa/oakridge/lib/request-identity.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(selectRequestIdentity(first, "thread-1", () => "ping-2")).toBe(first);` | `expect(readPendingCommand(first)?.request_id).toBe("ping-1"); expect(readPendingCommand(first)).toEqual(first);` | Pending command storage preserves the submitted request ID for retry. The object is deserialized, so reference equality is no longer asserted. The generated command submission comes from `makeCommandSubmission`. |
| Translated | `expect(selectRequestIdentity(first, "thread-2", () => "ping-2").idempotency_key).toBe("ping-2");` | `expect([readPendingCommand(first)?.request_id, readPendingCommand(second)?.request_id]).toEqual(["ping-1", "ping-2"]);` | Different generated scope identities keep their pending command keys separate. The old free-form thread identity is now a scope/command/target key. |
| **Relaxed** | `expect(retry).toBe(first);` after serializing the same `launchRequest("Build it")` | `expect(readPendingLaunch()).toEqual(first);` | The pending pinned-run request survives uncertain delivery and preserves its `request_id`, digest and input. The stored JSON returns a new object, so old reference equality is no longer tested. `makeStartPinnedRunRequest` supplies the request. |
| **Relaxed** | `expect(changed.idempotency_key).toBe("launch-2");` after changing launch notes | `expect(readPendingLaunch()?.request_id).toBe("launch-2");` after `discardPendingLaunch()` and saving a new request | The UI now retains an uncertain launch until the operator discards it. Editing input alone does not mint another key; the explicit discard step is a changed safety policy. |
| Translated | `expect(foundation.idempotency_key).not.toBe(web.idempotency_key);` | `expect(operatorDraftIdentity(first)).not.toBe(operatorDraftIdentity(second));` | Distinct generated scopes have distinct storage identities even for the same command key; v15 stage/unit composite keys are retired. |

## `kbbl/core/pwa/oakridge/__tests__/GateDecisionActions.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `await waitFor(() => expect(requestBody?.artifact_revision_id).toBe("revision-edited"));` | `expect(request.targets).toEqual([{ identity: "revision-edited", version: 2 }]);` | The generated command request carries the selected edited revision in its observed target list. `makeScopeView` and `makeCommand` build the read-model fixture. |
| Translated | `expect(onComplete).not.toHaveBeenCalled();` | `expect(onRefresh).not.toHaveBeenCalled();` | When a command response arrives after switching revisions, the unmounted command form no longer refreshes the new review. `OperatorCommandForm` now guards completion callbacks. |
| Translated | `expect(screen.queryByTestId("or-decision-success")).toBeNull();` | `expect(screen.queryByText("Command accepted.")).toBeNull();` | The stale response does not display success in the new revision's command form. |
| Translated | `expect(screen.getByTestId("or-decision-approve")).toBeTruthy();` | `expect(screen.getByRole("button", { name: "Submit Approve" })).toBeTruthy();` | The new revision keeps its own available command after the stale response resolves. |
| Unportable | `expect(requests.map((request) => request.feedback)).toEqual(["First explanation", "Better explanation"]);` | No equivalent feedback-panel assertion. | The current command form renders fields from a pinned payload schema; it has no special `request_revision` feedback panel. The two old feedback strings are not a generic command contract. |
| Unportable | `expect(requests[0].idempotency_key).not.toBe(requests[1].idempotency_key);` | No equivalent changed-feedback assertion. | After uncertain delivery, the current form retries a retained request ID and payload until resolved. It does not mint a new key on edits to an in-flight feedback panel. |
| Replacement | `expect(stranded.textContent).toBe("Run cancelled — gate stranded");` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | A terminal scope with no available command hides review actions; the stable inbox can retain a settled row. The old stranded-gate text is retired. |
| **Relaxed** | `expect((screen.getByTestId("or-decision-approve") as HTMLButtonElement).disabled).toBe(true);` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | The unavailable command cannot be clicked, but the old visible disabled button is absent. |
| **Relaxed** | `expect((screen.getByTestId("or-decision-request_revision") as HTMLButtonElement).disabled).toBe(true);` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | The unavailable revision command cannot be clicked; its separate disabled button is not shown. |
| Replacement | `expect(screen.queryByTestId("or-decision-feedback")).toBeNull();` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | A terminal scope offers no payload form, so the old feedback textarea cannot be opened; that dedicated panel no longer exists. |
| Translated | `expect(fetchMock).not.toHaveBeenCalled();` | `expect(fetch).not.toHaveBeenCalled();` | Removing unavailable commands causes no command submission. |
| Unportable | `expect(screen.getByRole("button", { name: "Send feedback" })).toBeTruthy();` | No equivalent assertion. | Feedback is now a pinned command payload; no generic **Send feedback** panel is part of `GateDecisionActions`. |
| Replacement | `expect(screen.queryByRole("button", { name: "Send feedback" })).toBeNull();` | `expect(screen.queryByTestId("or-gate-actions")).toBeNull();` | When the command disappears from the scope projection, the command form unmounts. This replaces closing the old feedback panel. |

## `kbbl/core/pwa/oakridge/__tests__/ReviewInboxView.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(await screen.findAllByTestId("or-review-inbox-item")).toHaveLength(2);` | `expect(rows.map((row) => row.querySelector("h2")?.textContent)).toEqual(["Admit API", "Review web artifact"]);` | Two generated command items appear once, in projection order. The items come from `makeInboxCommand` and `makeReviewInbox`. |
| Unportable | `expect(screen.queryAllByTestId("or-cohort-lifecycle-card")).toHaveLength(0);` | No equivalent lifecycle-card assertion. | The generated inbox has command, wait and diagnostic items; it no longer renders a second v15 cohort-progress collection. Absence of a retired test ID would prove nothing about duplicates. |
| Replacement | `expect(screen.getByText("Artifact ready for review")).toBeTruthy();` | `expect(rows.map((row) => row.querySelector("h2")?.textContent)).toEqual(["Admit API", "Review web artifact"]);` | Command labels now come from the pinned scope definition. The old lifecycle phrase is retired. |
| **Relaxed** | `expect(screen.getByTestId("or-inbox-admit-btn")).toBeTruthy();` | `expect(rows[0]?.querySelector("button")?.textContent).toBe("Open work");` | The inbox opens the scope containing the admission command; it no longer offers a direct admission button. |
| **Relaxed** | `expect(handlers.onSelectArtifact).toHaveBeenCalledWith("revision-web");` | `expect(onSelectScope).toHaveBeenCalledWith("run-one", "scope-web");` | The inbox navigates to the exact scope, where its observed revision is available. Direct revision navigation is gone. |
| Translated | `expect(handlers.onSelectRun).toHaveBeenCalledWith("run-1");` | `expect(onSelectScope).toHaveBeenCalledWith("run-one", "scope-web");` | Run navigation now includes the scope that requires attention. |
| Unportable | `await waitFor(() => expect(fetchMock.mock.calls.some(([input, init]) => init?.method === "POST" && String(input).includes("/gates/stage-build%3Aweb/resume"))).toBe(true));` | No direct inbox POST assertion. | The inbox now opens a scope; `GateDecisionActions` submits the generated command there. The v15 gate resume route is retired. |
| Unportable | `expect(JSON.parse(String(request.body))).toMatchObject({ action: "approve", operator_comment: "Approve artifact", feedback: "" });` | No direct inbox payload assertion. | The generated command payload is defined by the pinned schema and sent from the scope review, not a hard-coded inbox approve action. |
| Replacement | `await waitFor(() => expect(screen.queryByTestId("or-decision-approve")).toBeNull());` | `expect(rows).toEqual(["settled:Brief A", "live:Brief B", "live:Assessment"]);` | A departed command stays as a disabled settled row after refresh. The inbox no longer owns an approve button. |
| Translated | `expect(fetchMock.mock.calls.filter(([, init]) => init?.method !== "POST").length).toBeGreaterThanOrEqual(2);` | `expect(fetch).toHaveBeenCalledTimes(2);` | The stable-row test proves the inbox is fetched again after Refresh; there is no POST in the current inbox. |
| Unportable | `expect(send.disabled).toBe(true);` | No equivalent direct-feedback assertion. | The review inbox has no `Send feedback` form; feedback fields live in pinned scope commands. |
| Unportable | `await waitFor(() => expect(fetchMock.mock.calls.some(([, init]) => init?.method === "POST")).toBe(true));` | No equivalent direct-feedback POST assertion. | Submission occurs on the scope command form after navigation. |
| Unportable | `expect(JSON.parse(String(request.body))).toMatchObject({ action: "request_revision", feedback: "Explain the recovery path." });` | No equivalent direct-feedback payload assertion. | The current command schema decides the payload fields; the retired gate action and feedback shape are not a PWA contract. |
| Replacement | `expect((await screen.findByTestId("or-review-inbox-blocked")).textContent).toContain("database");` | `expect(await screen.findByText("database blocks admission")).toBeTruthy();` | Generated diagnostic detail names the blocker, but the old blocked cohort card is retired. |
| Translated | `expect(screen.queryByTestId("or-inbox-admit-btn")).toBeNull();` | `expect(screen.queryByRole("button", { name: /Admit/ })).toBeNull();` | A diagnostic item offers no direct admission action. |
| Translated | `expect(await screen.findByText("Brief approved · queued automatically")).toBeTruthy();` | Same assertion. | A generated wait item carries the visible automatic queue label. |
| Translated | `expect(screen.queryByTestId("or-inbox-admit-btn")).toBeNull();` for automatic work | `expect(screen.queryByRole("button", { name: /Submit/ })).toBeNull();` | Automatic waiting work has no direct decision submission control. |
| Unportable | `for (const label of labels) expect(screen.getByText(label)).toBeTruthy();` | No equivalent lifecycle-label assertion. | The generated inbox lists active command, wait and diagnostic descriptions; it does not project all ten v15 cohort lifecycle states or their fixed English labels. |
| Unportable | `expect(screen.getByText("Complete")).toBeTruthy();` | No equivalent completed-cohort assertion. | Terminal scopes leave the attention inbox; completed scope state is read on the run surface. |
| Translated | `expect(await screen.findByText("Confirm the merged pull request")).toBeTruthy();` | Same assertion. | The pinned merge-confirmation command is distinct from artifact review. |
| **Relaxed** | `expect(screen.getByRole("button", { name: "Confirm merge" })).toBeTruthy();` | `expect(screen.getByRole("button", { name: "Open work" })).toBeTruthy();` | The command is reachable at its scope, but no longer executable directly from the inbox. |
| Translated | `expect(await screen.findByText("Pull request needs attention")).toBeTruthy();` | `expect(await screen.findByText(/Pull request needs attention/)).toBeTruthy();` | The generated diagnostic's detail names the mismatch; its label is no longer a separate lifecycle field. |
| Translated | `expect(screen.getByText("observed pull request belongs to another repository")).toBeTruthy();` | `expect(detail.textContent).toContain("observed pull request belongs to another repository");` | The diagnostic preserves the reconciliation detail. |
| Unportable | `expect(screen.getByRole("link", { name: "Open pull request" })).toBeTruthy();` | No equivalent inbox link assertion. | The diagnostic variant has only `detail`, run ID and scope ID; it does not carry a PR URL. The operator opens the scope for related outputs. |
| Translated | `expect(rows).toEqual(["settled:Brief A", "live:Brief B", "live:Assessment"]);` | Same assertion using generated command rows with `data-state`. | The row position and append behavior are preserved end to end. The test refreshes `ReviewInboxView` from the shared factory and checks all three positions. |
| Unportable | `expect(screen.getByText("Merged · complete")).toBeTruthy();` | No equivalent inbox assertion. | Completed scopes no longer occupy the attention inbox. Their terminal outcome is shown in the run projection. |

## `kbbl/core/pwa/oakridge/lib/run-accent.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unchanged | `expect(selectRunAccentClass(runId)).toBe(selectRunAccentClass(runId));` | Same assertion. | The old pure hash is restored; `RUN_IDS` now passes through `makeRunSummary`. |
| Unchanged | `expect(RUN_ACCENT_CLASSES).toContain(selectRunAccentClass(runId));` | Same assertion. | The enum palette and membership claim are unchanged. |
| Unchanged | `expect(selectRunAccentClass("9f543628-5abf-4592-8896-1a2580e62dd8")).toBe("or-run-accent--5");` | Same assertion. | Golden value remains stable across process restarts. |
| Unchanged | `expect(selectRunAccentClass("78e2f663-5323-4a43-a518-a2750f9d5690")).toBe("or-run-accent--6");` | Same assertion. | Golden value remains stable across process restarts. |
| Unchanged | `expect(selectRunAccentClass("run-1")).toBe("or-run-accent--4");` | Same assertion. | Golden value remains stable across process restarts. |
| Unchanged | `expect(assigned.size).toBe(RUN_ACCENT_CLASSES.length);` | Same assertion. | A broad ID sample still spans the palette. |
| Unchanged | `expect(new Set(RUN_ACCENT_CLASSES).size).toBe(8);` | Same assertion. | The palette still has exactly eight distinct classes. |

`RunIdentityHeader.test.tsx` additionally checks that the generated run header actually applies the selected class and renders the existing accent bar. The restored selector is therefore used by the current surface, not just passing as an unused helper.

## `kbbl/core/pwa/oakridge/lib/build-brief.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(isBuildBrief(validBrief)).toBe(true);` | `expect([selectFieldText(body, schemas, "cohort_id"), selectFieldText(body, schemas, "title"), selectFieldText(body, schemas, "goal")]).toEqual(["brief-ui", "Build brief review UI", "Make the brief reviewable."]);` | The checked `brief_body` from `makeBuildBriefFixture` exposes its registered fields, but this PWA selector does not validate raw JSON. The compiler performs that validation before publication. |
| Unportable | `expect(isBuildBrief({ ...validBrief, decisions_made: [{ decision: "Missing rationale" }] })).toBe(false);` | No equivalent PWA validation assertion. | A checked `brief_decision` always has the schema's rationale field. The PWA cannot receive an incomplete decision body. The new suite separately checks that the rationale is read by its schema key. |
| Unportable | `expect(isBuildBrief({ ...validBrief, [field]: "   " })).toBe(false);` for `cohort_id` | No equivalent PWA validation assertion. | The compiler's `ident` schema checks raw cohort IDs. The PWA consumes the already checked value. |
| Unportable | `expect(isBuildBrief({ ...validBrief, [field]: "   " })).toBe(false);` for `repository_key` | No equivalent PWA validation assertion. | The compiler's `ident` schema checks raw repository keys. The PWA consumes the already checked value. |

## `kbbl/core/pwa/oakridge/lib/run-activity.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(items.map((item) => item.sequence)).toEqual(["12", "10"]);` | `expect(within(pane).getAllByRole("listitem").map((item) => item.textContent?.match(/Version (\d+)/)?.[1])).toEqual(["12", "10"]);` | The authority history endpoint scopes by run and scope and orders transitions newest first; the PWA displays that order. The old client-side filtering of a mixed-run ledger page is no longer tested. `makeScopeHistory` and `makeScopeTransition` supply the generated projection. |
| Unportable | `expect(selectRunActivity([publication], "run-1")[0]).toMatchObject({ summary: "Output published", is_optional_attention: true });` | No equivalent activity-list assertion. | Generated transitions describe scope decisions; the old slot-release operation and `optional` continuation flag are absent. Current attention notifications are covered in `run-notifications.test.ts`. |
| Unportable | `expect(selectRunActivity([event({ sequence: "30", operation: "work_started" })], "run-1")).toEqual([]);` | No equivalent filtering assertion. | Scope history intentionally shows every committed transition; the old run-event operation filter is retired. |
| Translated | `expect(request).toHaveBeenCalledWith("/oakridge/api/run_events?limit=500&run_id=run%2Fone");` | `expect(fetch.mock.calls[0]?.[0]).toBe("/oakridge/api/api/runs/run%2Fone/scopes/scope%2Fone/history");` | The request is still bounded to an escaped run ID, now also to the selected scope. The v15 run-events ledger route is retired. |

## `kbbl/core/pwa/oakridge/lib/build-result.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(result.ok && [result.value.tests.summary, result.value.delegated_session_metadata?.branch]).toEqual([null, null]);` | `expect([tests && selectFieldText(tests, schemas, "summary"), metadata && selectFieldText(metadata, schemas, "branch")]).toEqual([null, null]);` | The checked optional fields are null as before, but raw-body parsing is done by the compiler. `makeBuildResultFixture` supplies the generated checked body and schema. |
| Unportable | `expect(result.ok ? null : result.error.field).toBe("known_issues[0]");` | No equivalent PWA assertion. | Unknown issue severity is rejected against the pinned enum before the PWA receives a checked revision; the old parser error field is retired. |
| Unportable | `expect(parseBuildResult({ ...body, tests: { output: "ran" } }).ok).toBe(false);` | No equivalent PWA assertion. | The compiler enforces required `passed` and `failed` fields. The PWA does not parse raw build results. |
| Unportable | `expect(comparison.changed_in_scope).toEqual(["src/api.py", "docs/guide.md"]);` | No equivalent comparison assertion. | The checked build result and brief are separate output slots; the viewer currently receives only `build_body`, so planned-directory matching is unavailable. |
| Unportable | `expect(comparison.changed_out_of_scope).toEqual(["ci.yml"]);` | No equivalent comparison assertion. | Cross-output file-scope comparison is absent. The viewer lists `ci.yml` but does not flag it as out of scope. |
| Unportable | `expect(comparison.planned_untouched).toEqual(["src/errors.py"]);` | No equivalent comparison assertion. | The current viewer does not receive the brief's planned file list. |
| Translated | `expect(ordered.map((issue) => issue.description)).toEqual(["b", "c", "a"]);` | `expect(selectOrderedCheckedIssues(body, schemas).map((issue) => selectFieldText(issue, schemas, "description"))).toEqual(["b", "c", "a"]);` | Checked issues keep blocking, warning, info order. `BuildResultViewer` uses this selector, and its component suite checks rendered order. |
| Unportable | `expect(selectTestEvidenceText({ passed: 1, failed: 0, output: "ok", summary: " ", cargo_test_output: null })).toEqual(["ok"]);` | No equivalent assertion. | The current generic typed viewer renders the checked test-evidence record, including its optional fields; it has no nonblank-text selector. This is a presentation coverage loss. |

## `kbbl/core/pwa/oakridge/lib/spec-analysis.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(isSpecAnalysis(analysis)).toBe(true);` | `expect(view.status_counts).toEqual([{ status: "blocking", count: 1 }, { status: "warning", count: 1 }, { status: "info", count: 1 }, { status: "blocked", count: 1 }, { status: "ambiguous", count: 1 }, { status: "implementable", count: 1 }]);` | The checked body from `makeSpecAnalysisFixture` is usable by the viewer, but the PWA no longer validates raw JSON; the compiler checks publication. |
| **Relaxed** | `expect(isSpecAnalysis({ ...analysis, findings: [], requirements: [], risks: [], source_spec_refs: [] })).toBe(true);` | `expect(screen.getByTestId("or-spec-no-blockers")).toBeTruthy();` in `SpecAnalysisViewer.test.tsx` | Empty checked lists render an explicit no-blockers state, but this does not validate the old raw-body shape. |
| Unportable | `expect(isSpecAnalysis({ ...analysis, risks: [{ description: "No plan" }] })).toBe(false);` | No equivalent PWA validation assertion. | The pinned `risk` record requires mitigation before a checked value can be published. |
| Unportable | `expect(isSpecAnalysis({ ...analysis, findings: [{ id: "f1", description: "x", severity: "critical" }] })).toBe(false);` | No equivalent PWA validation assertion. | `severity` is a pinned enum; the compiler rejects `critical`. |
| Unportable | `expect(isSpecAnalysis({ ...analysis, requirements: [{ id: "r1", description: "x", status: "done" }] })).toBe(false);` | No equivalent PWA validation assertion. | `requirement_status` is a pinned enum; the compiler rejects `done`. |
| Unportable | `expect(isSpecAnalysis(rest)).toBe(false);` where `rest` omits `source_spec_refs` | No equivalent PWA validation assertion. | The compiler requires the source list field. The checked viewer never receives a record without it. |
| Translated | `expect(view.blockers.map((blocker) => blocker.kind === "finding" ? blocker.finding.id : blocker.requirement.id)).toEqual(["f2", "r2"]);` | `expect(view.blockers.map((blocker) => selectFieldText(blocker.value, analysis.schemas, "id"))).toEqual(["f2", "r2"]);` | The checked selector groups the same blockers once, reading IDs through schema field positions. |
| Translated | `expect(view.findings.map((finding) => finding.id)).toEqual(["f3", "f1"]);` | `expect(view.findings.map((finding) => selectFieldText(finding, analysis.schemas, "id"))).toEqual(["f3", "f1"]);` | Nonblocking findings retain warning-before-info order. |
| Translated | `expect(view.requirements.map((requirement) => requirement.id)).toEqual(["r3", "r1"]);` | `expect(view.requirements.map((requirement) => selectFieldText(requirement, analysis.schemas, "id"))).toEqual(["r3", "r1"]);` | Nonblocked requirements retain ambiguous-before-implementable order. |
| Translated | `expect(view.tally.status_counts).toEqual([{ status: "blocking", count: 1 }, { status: "warning", count: 1 }, { status: "info", count: 1 }, { status: "blocked", count: 1 }, { status: "ambiguous", count: 1 }, { status: "implementable", count: 1 }]);` | `expect(view.status_counts).toEqual([{ status: "blocking", count: 1 }, { status: "warning", count: 1 }, { status: "info", count: 1 }, { status: "blocked", count: 1 }, { status: "ambiguous", count: 1 }, { status: "implementable", count: 1 }]);` | The same statuses and counts remain in the same urgency order. |
| Translated | `expect(onlyInfo.tally.status_counts).toEqual([{ status: "info", count: 1 }]);` | `expect(selectCheckedSpecAnalysisView(onlyInfo.body, onlyInfo.schemas).status_counts).toEqual([{ status: "info", count: 1 }]);` | The tally still omits zero-count statuses. |

## `kbbl/core/pwa/oakridge/lib/assessment.test.ts`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(parseAssessment(body).ok).toBe(true);` | `expect(screen.getByTestId("or-assessment-verdict").textContent).toBe("Fail");` in `AssessmentViewer.test.tsx` | A checked assessment from `makeAssessmentFixture` renders, but raw-body validation has moved to the compiler. |
| **Relaxed** | `expect(parsed.ok && parsed.value.test_evidence).toBeNull();` | `expect(selectCheckedField(body, schemas, "test_evidence")?.data).toEqual({ kind: "optional", value: null });` | The optional checked field remains null. This no longer tests parsing a raw `test_evidence: null` body. |
| Unportable | `expect(parsed.ok ? null : parsed.error.field).toBe("findings[1].status");` | No equivalent PWA validation assertion. | The compiler rejects an unknown `criterion_status` enum before projection. |
| Unportable | `expect(parsed.ok ? null : parsed.error.field).toBe("findings[0].evidence");` | No equivalent PWA validation assertion. | The pinned `optional_text` schema rejects numeric evidence before projection. |
| **Relaxed** | `expect(parsed.ok && [parsed.value.findings[0]?.status, parsed.value.findings[0]?.description]).toEqual([null, null]);` | `expect(finding && [selectFieldText(finding, schemas, "status"), selectFieldText(finding, schemas, "description")]).toEqual([null, null]);` | Omitted optional values are null in the checked record; the PWA no longer supplies parser defaults for missing raw properties. |
| Unportable | `expect(parsed.ok ? null : parsed.error.field).toBe("test_evidence.passed");` | No equivalent PWA validation assertion. | The compiler validates the pinned integer count and reports the raw-body error before publication. |
| Unportable | `expect(parseAssessment({ ...body, verdict: "maybe" }).ok).toBe(false);` | No equivalent PWA validation assertion. | The pinned verdict enum rejects unknown variants before the PWA reads it. |
| **Relaxed** | `expect(report.needs_attention.map(label)).toEqual(["#1", "Extra.", "#4", "#3"]);` | `expect(view.needs_attention.map((finding) => selectFieldText(finding, report.schemas, "criterion"))).toEqual(["One.", "Extra.", "Four."]);` | Unmet findings precede partial findings, but the viewer has no brief criteria with which to number them or infer unassessed criterion `#3`. |
| **Relaxed** | `expect(report.met.map(label)).toEqual(["#2"]);` | `expect(view.met.map((finding) => selectFieldText(finding, report.schemas, "criterion"))).toEqual(["Two."]);` | Met findings remain separate and folded in the viewer, but brief position numbering is no longer available. |
| **Relaxed** | `expect(report.tally).toEqual({ met: 1, partial: 1, not_met: 2, unassessed: 1 });` | `expect(selectCheckedAssessmentView(report.body, report.schemas).status_counts).toEqual([{ status: "not_met", count: 2 }, { status: "partial", count: 1 }, { status: "met", count: 1 }]);` | Every explicit finding is counted with the same status, but unassessed brief criterion `#3` cannot be inferred without the brief. |
| Unportable | `expect(drifted.met.map(label)).toEqual(["#1"]);` | No equivalent brief-matching assertion. | The checked assessment viewer does not receive brief criteria, so whitespace-normalized matching is unavailable. |
| Translated | `expect(selectCriterionReport(null, [finding("Alone.", "partial")]).needs_attention.map(label)).toEqual(["Alone."]);` | `expect(selectCheckedAssessmentView(body, schemas).needs_attention.map((finding) => selectFieldText(finding, schemas, "criterion"))).toEqual(["Alone."]);` | A finding remains visible without loading a brief. |
| Translated | `expect(selectCriterionCounts({ met: 3, partial: 0, not_met: 1, unassessed: 0 })).toEqual([{ status: "not_met", count: 1 }, { status: "met", count: 3 }]);` | `expect(selectCheckedAssessmentView(body, schemas).status_counts).toEqual([{ status: "not_met", count: 1 }, { status: "met", count: 3 }]);` | Zero counts are omitted and the worst nonzero status leads. |

## `kbbl/core/pwa/oakridge/components/molecules/ExpandableText.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unchanged | `expect(screen.queryByRole("button")).toBeNull();` | Same assertion. | A text block that fits has no disclosure control. The layout stub uses DOM measurements, not a hand-written read-model fixture. |
| Unchanged | `expect(screen.getByRole("button", { name: "Show less" }).getAttribute("aria-expanded")).toBe("true");` | Same assertion. | Long text still expands on click. The restored component is used for checked analysis summaries and build-brief goals. |

## `kbbl/core/pwa/oakridge/lib/brief-notes.test.ts`

The file handle in every assertion is now made by `makeBriefNotesFile` in the shared fixture factory. The pinned development root input has a string `spec` field; the launch view uses `readBriefNotesFile` to populate it. The old mandatory-brief form validation is a separate, retired contract because the pinned `spec` schema permits empty text.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(selectBriefNotesFileRefusal(file("brief.md", 4_096))).toBeNull();` | `expect(selectBriefNotesFileRefusal(makeBriefNotesFile("brief.md", 4_096))).toBeNull();` | Same size guard, shared file fixture. |
| Translated | `expect(selectBriefNotesFileRefusal(file("brief.md", 0))?.detail).toBe("brief.md is empty.");` | `expect(selectBriefNotesFileRefusal(makeBriefNotesFile("brief.md", 0))?.detail).toBe("brief.md is empty.");` | Empty file refusal is identical. |
| Translated | `expect(refusal?.detail).toBe("dump.json is 1.0 MB, over the 1.0 MB limit for brief notes.");` | Same assertion, with `makeBriefNotesFile("dump.json", MAX_BRIEF_NOTES_BYTES + 1)` creating the handle. | Oversize file refusal still reports the file and limit. |
| Translated | `expect(selectBriefNotesFileRefusal(file("brief.md", MAX_BRIEF_NOTES_BYTES))).toBeNull();` | `expect(selectBriefNotesFileRefusal(makeBriefNotesFile("brief.md", MAX_BRIEF_NOTES_BYTES))).toBeNull();` | Exact limit remains accepted. |
| Translated | `expect(selectLoadedBriefNotesRefusal(file("brief.md", 12), "Ship it")).toBeNull();` | `expect(selectLoadedBriefNotesRefusal(makeBriefNotesFile("brief.md", 12), "Ship it")).toBeNull();` | Content acceptance is unchanged. |
| Translated | `expect(selectLoadedBriefNotesRefusal(file("brief.md", 12), "  \\n\\t ")?.detail).toBe("brief.md has no readable text.");` | `expect(selectLoadedBriefNotesRefusal(makeBriefNotesFile("brief.md", 12), "  \\n\\t ")?.detail).toBe("brief.md has no readable text.");` | Whitespace-only file refusal is unchanged. |
| Translated | `expect(await readBriefNotesFile(file("brief.md", 7, "Ship it"))).toEqual({ ok: true, value: { text: "Ship it", file_name: "brief.md" } });` | `expect(await readBriefNotesFile(makeBriefNotesFile("brief.md", 7, "Ship it"))).toEqual({ ok: true, value: { text: "Ship it", file_name: "brief.md" } });` | The reader still returns the exact content and filename. |
| Translated | `expect(result.ok && result.value.text).toBe(body);` | Same assertion, with `makeBriefNotesFile("brief.md", body.length, body)` creating the handle. | Trailing structure is preserved. |
| Translated | `expect(result.ok).toBe(false); expect(read).toBe(false);` | Same assertions, with an oversize `makeBriefNotesFile` handle. | Rejection still occurs before file IO. |
| Translated | `expect(result).toEqual({ ok: false, error: { operation: "read_brief_notes_file", detail: "Could not read brief.md." } });` | Same assertion, with a rejecting `makeBriefNotesFile` handle. | Read failures remain error values. |
| Unchanged helper; replacement surface | `expect(selectMissingBriefNotesDetail({ kind: "typed" })).toBe("Brief notes are required.");` | Same helper assertion; no equivalent launch-form assertion. | The pinned `spec` schema allows empty text, so launch no longer rejects an absent typed brief. This is a recorded UI coverage loss, not a translation. |
| Unchanged helper; replacement surface | `expect(selectMissingBriefNotesDetail({ kind: "file", file_name: "" })).toBe("Choose a file with the brief notes.");` | Same helper assertion; no equivalent launch-form assertion. | The file picker is optional under the pinned input contract. A missing file does not block launch. |
| Unchanged | `expect(formatBytes(4_096)).toBe("4 KB");` | Same assertion. | Kilobyte message formatting is preserved. |
| Unchanged | `expect(formatBytes(2_621_440)).toBe("2.5 MB");` | Same assertion. | Megabyte message formatting is preserved. |
| Unchanged | `expect(formatBytes(12)).toBe("1 KB");` | Same assertion. | Small nonempty files do not round to zero. |

The launch integration additionally checks that selecting `brief.md` places its exact text in the generated `spec` field and displays the filename.

## `kbbl/core/pwa/oakridge/lib/stage-unit-params.test.ts`

The original suite used a captured `/runs/:id` v15 payload to catch a handwritten `StageUnitParams` type that compiled but missed the real nested brief. Current scope outputs carry a checked revision, and the sidebar uses `selectRunArtifacts` to expose it. The new factory builds the same field values from the pinned `brief_body` schema. This is **relaxed** relative to the old live-payload regression guard: it does not prove that an external payload has the expected shape.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| **Relaxed** | `expect(brief?.title).toBe("End-to-end, browser, offline and packaging acceptance");` | `expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "title")).toBe("End-to-end, browser, offline and packaging acceptance");` | The exact title is retained in a generated checked revision, but the original captured response is no longer exercised. |
| **Relaxed** | `expect(brief?.repository_key).toBe("assay");` | `expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "repository_key")).toBe("assay");` | The generated brief projects the same repository key; live-payload shape coverage is lost. |
| **Relaxed** | `expect(brief?.goal).toContain("Close out the required cases");` | `expect(artifact && selectFieldText(artifact.revision.body, brief.schemas, "goal")).toContain("Close out the required cases");` | The goal claim remains, but uses a schema-built fixture. |
| **Relaxed** | `expect(brief?.files_in_scope).toContain("tests/test_review_acceptance.py");` | `expect(artifact && selectFieldItems(artifact.revision.body, brief.schemas, "files_in_scope").map(selectCheckedText)).toContain("tests/test_review_acceptance.py");` | The file is present in the checked list; the original response mapping is untested. |
| **Relaxed** | `expect(brief?.depends_on).toEqual(["review-cli", "frontend-bundle"]);` | `expect(artifact && selectFieldItems(artifact.revision.body, brief.schemas, "depends_on").map(selectCheckedText)).toEqual(["review-cli", "frontend-bundle"]);` | Dependency order survives in the checked list, with the same fixture limitation. |
| Replacement | `expect(selectCohortBrief(makeUnit({}))).toBeNull();` | `expect(selectRunArtifacts([makeScopeView({ outputs: [] })]).find((artifact) => artifact.output.output_key === "brief")).toBeUndefined();` | The replacement surface has no `params`; a scope with no output has no brief in the sidebar. |
| Replacement | `expect(selectCohortBrief(makeUnit(assessorParams as StageUnit["params"]))).toBeNull();` | `expect(selectRunArtifacts([makeScopeWithOutput({ body: result.body, output_key: "build_result" })]).find((artifact) => artifact.revision.body.schema === "brief_body")).toBeUndefined();` | An assessor's checked build result is a distinct output schema. |
| Replacement | `expect(selectCohortBrief(makeUnit(null))).toBeNull();` | `expect(selectRunArtifacts([scope]).find((artifact) => artifact.output.output_key === "brief")).toBeUndefined();` | An output slot without a revision is not shown as an artifact. |

## `kbbl/core/pwa/oakridge/lib/cohort-artifact.test.ts`

The v15 run exposed a history of artifact revisions and supported a sibling lookup as of an arbitrary timestamp. The generated scope read model exposes each slot's **current** revision. `RunWorkspaceSidebar` uses `selectRunArtifacts`; `ArtifactReview` opens a revision found by `selectArtifactInScopes`. The replacement suite tests current output identity with shared checked fixtures. Historical sibling comparison is a recorded coverage loss: neither the current PWA client nor the scope projection supplies the old revision timeline.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replacement | `expect(selectCohortArtifactId(run, "dev.build_brief", "cm-api")).toBe("brief-new");` | `expect(artifact && [artifact.output.collection_key, artifact.revision.body.schema]).toEqual(["cm-api", "brief_body"]);` for revision `brief-new` | The slot already projects its current revision. It does not prove the old latest-version reduction over historical entries. |
| Replacement | `expect(selectCohortArtifactId(run, "dev.build_result", "cm-api")).toBe("result");` | `expect(artifact && [artifact.output.collection_key, artifact.revision.body.schema]).toEqual(["cm-api", "build_body"]);` for revision `result` | Output key, collection key and checked body schema distinguish result from brief. |
| Replacement | `expect(selectCohortArtifactId(run, "dev.build_brief", "cm-ui")).toBeNull();` | `expect(selectRunArtifacts(scopes).find((artifact) => artifact.output.collection_key === "cm-ui")).toBeUndefined();` | No published output for that collection appears in the sidebar. |
| Unportable | `expect(title(selectCohortArtifactLookup(sources, readBuildBrief))).toBe("Assemble the API");` | No as-of assertion. | The current projection has only the current revision and cannot select the brief as it stood at the viewed revision's timestamp. |
| Unportable | `expect(title(selectCohortArtifactLookup({ ...sources, as_of: "2026-10-04T00:00:00Z" }, readBuildBrief))).toBe("Revised after the build");` | No as-of assertion. | Historical revisions are not projected to the PWA. |
| Unportable | `expect(selectCohortArtifactLookup({ ...sources, as_of: "2026-09-30T00:00:00Z" }, readBuildBrief).kind).toBe("missing");` | No as-of assertion. | The current slot cannot answer whether a brief existed before its current revision. |
| Replacement | `expect(selectCohortArtifactLookup({ ...sources, detail: loading }, readBuildBrief).kind).toBe("loading");` | No assertion in this suite. | The replacement surface loads scope projections. `RunWorkspace` renders a loading state for a scope request; there is no separate sibling artifact request. |
| Replacement | `expect(selectCohortArtifactLookup({ ...sources, detail: failed }, readBuildBrief).kind).toBe("error");` | No assertion in this suite. | Scope load errors appear in the workspace instead of an artifact-detail query result. This exact sibling error distinction is retired. |
| Replacement | `expect(selectCohortArtifactLookup({ ...sources, run: failed }, readBuildBrief).kind).toBe("error");` | No assertion in this suite. | A failed run query displays a run-load alert, already covered by the workspace boundary tests. |
| Unportable | `expect(selectCohortArtifactLookup({ ...sources, detail: stale }, readBuildBrief).kind).toBe("found");` | No stale-sibling assertion. | There is no separate historical sibling query to retain after a refetch failure. Scope-query stale data behavior is a different contract. |
| Replacement | `expect(selectCohortArtifactLookup({ ...sources, artifact_id: null }, readBuildBrief).kind).toBe("missing");` | `expect(selectRunArtifacts(scopes).find((artifact) => artifact.output.collection_key === "cm-ui")).toBeUndefined();` | A missing current output is absent from the sidebar; the old lookup result variant is retired. |
| Unportable | `expect(selectCohortArtifactLookup({ ...sources, detail: broken }, readBuildBrief).kind).toBe("missing");` | No malformed-body assertion. | The compiler checks `brief_body` before publishing a revision, so the PWA does not parse raw invalid artifact bodies. |
| Replacement | `expect(selectCohortArtifactLookup({ ...sources, cohort_label: null }, readBuildBrief).kind).toBe("missing");` | `expect(selectRunArtifacts(scopes).find((artifact) => artifact.output.collection_key === "cm-ui")).toBeUndefined();` | Current output collection keys are explicit; there is no nullable cohort lookup input. |

## `kbbl/core/pwa/oakridge/lib/run-overview.test.ts`

The v15 overview joined separate run, gate and executor-attempt reads. The generated overview derives progress and actions from scope summaries and projections. The replacement suite uses the shared read-model factory. Each source assertion is listed below; a generated scope does not imply that the separate v15 read states or recent-release history survived. Whitespace in multi-line original assertions is normalized for the table, without changing code tokens.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Replacement | `expect(hasOpenPullRequestMergeWait({ ...input, items: [mergeWait()] })).toBe(true);` | `expect(selectActionableScopes([scope]).map((item) => item.scope_id)).toEqual(["build-1"]);` | An available confirm-merged command opens its generated scope. The v15 pull-request-merge inbox item is retired. |
| **Relaxed** | `expect(hasOpenPullRequestMergeWait({ ...input, items: [mergeWait({ unit_id: "unit-2" }), mergeWait({ state: "blocked" })], })).toBe(false);` | `expect(selectActionableScopes([other, terminal]).find((scope) => scope.scope_id === "build-1")).toBeUndefined();` | A terminal scope has no action and another scope cannot satisfy its identity. This does not check the old blocked-inbox-item state. |
| Unportable | `expect(overview.status).toBe("failed");` | No equivalent assertion. | The generated run view has no v15 status, is_stuck, or parked_count fields. Scope terminal and command state are now the projected status sources. |
| Unportable | `expect(overview.is_stuck).toBe(true);` | No equivalent assertion. | The generated run view has no v15 status, is_stuck, or parked_count fields. Scope terminal and command state are now the projected status sources. |
| Unportable | `expect(overview.parked_count).toBe(3);` | No equivalent assertion. | The generated run view has no v15 status, is_stuck, or parked_count fields. Scope terminal and command state are now the projected status sources. |
| Unportable | `expect(overview.current_session?.session_id).toBe("sid-2");` | No equivalent assertion. | The current read model projects executions per scope, but no run-wide current session or v15 attempt label. The sidebar lists executions without selecting one as current. |
| Unportable | `expect(overview.current_session?.attempt_label).toBe("attempt 1");` | No equivalent assertion. | The current read model projects executions per scope, but no run-wide current session or v15 attempt label. The sidebar lists executions without selecting one as current. |
| Unportable | `expect(overview.current_session).toBeNull();` | No equivalent assertion. | The current read model projects executions per scope, but no run-wide current session or v15 attempt label. The sidebar lists executions without selecting one as current. |
| Unportable | `expect(overview.current_session?.session_id).toBe("sid-new");` | No equivalent assertion. | The current read model projects executions per scope, but no run-wide current session or v15 attempt label. The sidebar lists executions without selecting one as current. |
| Unportable | `expect(overview.current_session?.attempt_label).toBe("attempt 2 of 2");` | No equivalent assertion. | The current read model projects executions per scope, but no run-wide current session or v15 attempt label. The sidebar lists executions without selecting one as current. |
| Unportable | `expect(knownGates(overview).sessions_awaiting_action.map((ref) => ref.session_id)).toEqual([ "sid-2", ]);` | No equivalent assertion. | Commands belong to scopes, not a v15 gate joined to an executor attempt by stage/unit key. The old session action marker is retired. |
| Unportable | `expect(knownGates(overview).sessions_awaiting_action).toEqual([]);` | No equivalent assertion. | Commands belong to scopes, not a v15 gate joined to an executor attempt by stage/unit key. The old session action marker is retired. |
| Unportable | `expect(keys.has(unitActionKeyOf("build", "c2"))).toBe(true);` | No equivalent assertion. | Commands belong to scopes, not a v15 gate joined to an executor attempt by stage/unit key. The old session action marker is retired. |
| Unportable | `expect(keys.has(unitActionKeyOf("assess", "c2"))).toBe(false);` | No equivalent assertion. | Commands belong to scopes, not a v15 gate joined to an executor attempt by stage/unit key. The old session action marker is retired. |
| Replacement | `expect(active.map((entry) => entry.gate_id)).toEqual(["gate-open"]);` | `expect(selectActionableScopes([scope]).map((item) => item.scope_id)).toEqual(["build-1"]);` | Actionable scopes replace parked gate IDs; the command is available only while the scope is live. |
| Replacement | `expect(active[0].resume_actions).toEqual(["approve", "reject"]);` | `expect(selectActionableScopes([scope])[0]?.commands.map((command) => command.label)).toEqual(["Approve", "Reject"]);` | Available pinned commands replace gate resume_actions. The visible decisions remain distinct. |
| Unportable | `expect(selectRunGatesRead({ gates, is_pending: false, is_error: true })).toEqual({ kind: "loaded", gates, });` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(selectRunGatesRead({ gates: undefined, is_pending: false, is_error: true })).toEqual({ kind: "unavailable", });` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(selectRunGatesRead({ gates: undefined, is_pending: true, is_error: false })).toEqual({ kind: "pending", });` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(unreadOverview().gates).toEqual({ kind: "unavailable" });` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(overview.parked_count).toBe(1);` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(overview.current_session?.session_id).toBe("sid-1");` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(view.is_action_state_known).toBe(false);` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(view.rows.map((row) => row.requires_operator_action)).toEqual([false]);` | No equivalent assertion. | There is no separate run gate read or gate-read status. The workspace loads scope projections and displays their commands; gate-specific failure and stale-data distinctions are retired. |
| Unportable | `expect(unreadOverview().is_session_list_known).toBe(false);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(overview.gates.kind).toBe("known");` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(overview.is_session_list_known).toBe(false);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(unreadOverview().status).toBe("parked");` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(overview.is_session_list_known).toBe(true);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(overview.current_session).toBeNull();` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.is_action_state_known).toBe(true);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows.filter((row) => row.requires_operator_action).map((row) => row.session_id)).toEqual([ "sid-2", ]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows.map((row) => row.session_id)).toEqual(["sid-2"]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows.map((row) => row.attempt_label)).toEqual(["attempt 2 of 2"]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows.map((row) => row.work_order_id)).toEqual(["wo-1", "wo-2"]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.is_session_list_known).toBe(false);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows).toEqual([]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.is_session_list_known).toBe(true);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(view.rows).toEqual([]);` | No equivalent assertion. | Generated executions arrive inside each scope projection; there is no independent run sessions read with archive seed, purge set, work-order ID or v15 attempt label. This exact claim has no current equivalent. |
| Unportable | `expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([ "art-build-a", "art-build-b", "art-plan", ]);` | No equivalent assertion. | The current sidebar lists each output slot’s current revision; it has no recent-release feed, timestamp sort or cap. This old overview claim is retired. |
| Unportable | `expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([ "art-later", "art-earlier", ]);` | No equivalent assertion. | The current sidebar lists each output slot’s current revision; it has no recent-release feed, timestamp sort or cap. This old overview claim is retired. |
| Unportable | `expect(overview.recent_slot_releases.map((release) => release.artifact_id)).toEqual([ "art-dated", "art-undated", ]);` | No equivalent assertion. | The current sidebar lists each output slot’s current revision; it has no recent-release feed, timestamp sort or cap. This old overview claim is retired. |
| Unportable | `expect(overview.recent_slot_releases).toHaveLength(RECENT_SLOT_RELEASE_LIMIT);` | No equivalent assertion. | The current sidebar lists each output slot’s current revision; it has no recent-release feed, timestamp sort or cap. This old overview claim is retired. |
| **Relaxed** | `expect(overview.stage_progress).toEqual({ total: 3, complete: 1, parked: 1, pending: 1, running: 0, failed: 0, });` | `expect(selectRunProgress(run)).toEqual({ total: 3, complete: 1, needs_attention: 1 });` | The generated summary preserves total and complete, but collapses parked/pending/running/failed into terminal and attention. |
| Translated | `expect(overview.stage_progress.total).toBe(0);` | `expect(selectRunProgress(makeRunDetail())).toEqual({ total: 0, complete: 0, needs_attention: 0 });` | An empty generated scope list still yields zero total. |
| Translated | `expect(overview.stage_progress.complete).toBe(0);` | `expect(selectRunProgress(makeRunDetail())).toEqual({ total: 0, complete: 0, needs_attention: 0 });` | An empty generated scope list still yields zero complete. |

The current suite also asserts that only published current revisions appear in the artifact list and that a scope without executions contributes no sidebar session. Those are generated-surface assertions, not substitutes for historical release ordering or session-read failures.

## `kbbl/core/pwa/oakridge/__tests__/workflowdefs.test.tsx`

The list and editor now operate on generated pinned definition summaries and stored authoring choices. The source v15 stage graph and slot-binding editor are not part of this authoring surface. All test read models come from the shared factory. Whitespace in multi-line original assertions is normalized for the table.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(screen.getByTestId("or-def-list-loading")).toBeTruthy();` | `expect(screen.getByRole("status").textContent).toContain("Loading definitions");` | The generated catalog reports its pending query as a status message. |
| Translated | `expect(rows).toHaveLength(2);` | `expect((await screen.findAllByRole("button", { name: /development v/ })).length).toBe(2);` | Two pinned summaries built by the shared factory render two catalog entries. |
| Translated | `expect(await screen.findByTestId("or-def-list-empty")).toBeTruthy();` | `expect(await screen.findByText("No pinned definitions.")).toBeTruthy();` | The empty pinned catalog remains explicit. |
| Translated | `expect(await screen.findByTestId("or-def-list-error")).toBeTruthy();` | `expect((await screen.findByRole("alert")).textContent).toContain("server down");` | Failed catalog reads remain visible to the operator. |
| Translated | `expect(onNew).toHaveBeenCalled();` | `expect(onNew).toHaveBeenCalledOnce();` | The new-authoring navigation callback still fires. |
| Replacement | `expect(onClone).toHaveBeenCalledWith(expect.objectContaining({ id: "def-1" }));` | `expect(onClone).toHaveBeenCalledWith("bundle-1");` | The callback now carries the pinned bundle ID instead of a full v15 definition object. The old object payload is retired. |
| Replacement | `expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: "def-1" }));` | `expect(onSelect).toHaveBeenCalledWith("bundle-1");` | Selection now routes by pinned bundle ID rather than a v15 definition object. |
| Translated | `expect(await screen.findByTestId("or-def-detail")).toBeTruthy();` | `expect(detail.textContent).toContain("Root scope: development");` | The detail panel still appears after the catalog loads. |
| Replacement | `expect(screen.getAllByTestId("or-def-stage")).toHaveLength(1);` | `expect(detail.querySelectorAll("li").length).toBeGreaterThan(0);` | The detail lists generated scopes, rather than an editable v15 stage graph. |
| Unportable | `expect(screen.getByText("plan")).toBeTruthy();` | No equivalent assertion. | The pinned detail does not display a v15 input slot named plan. |
| Unportable | `expect(screen.getByText("result")).toBeTruthy();` | No equivalent assertion. | The pinned detail does not display a v15 output slot named result. |
| Unportable | `expect(screen.getByText("No connections.")).toBeTruthy();` | No equivalent assertion. | The pinned detail has no hand-authored edge list or No connections state. |
| Unportable | `expect(screen.getByText("Stage configuration")).toBeTruthy();` | No equivalent assertion. | The pinned detail does not expose individual v15 stage configuration. |
| Translated | `expect(await screen.findByTestId("or-def-editor")).toBeTruthy();` | `expect(screen.getByTestId("or-def-editor")).toBeTruthy();` | A new pinned authoring form still opens. |
| Translated | `expect(screen.getByTestId("or-def-editor-loading")).toBeTruthy();` | `expect(screen.getByRole("status").textContent).toContain("Loading definition");` | Clone-source loading remains visible. |
| Translated | `expect(await screen.findByTestId("or-def-editor-load-error")).toBeTruthy();` | `expect((await screen.findByRole("alert")).textContent).toContain("not found");` | A failed clone-source request remains visible. |
| Replacement | `expect(btn.disabled).toBe(true);` | `expect(screen.getByRole<HTMLButtonElement>("button", { name: "Compile definition" }).disabled).toBe(false);` | The pinned development template owns its scopes, so compilation is available without manually defining stages. The old disable rule is retired. |
| Replacement | `expect(screen.getByTestId("or-def-validation-errors")).toBeTruthy();` | `expect(key.checkValidity()).toBe(false);` | The required authoring key uses native form validity rather than a v15 validation-errors panel. |
| Translated | `expect(await screen.findByTestId("or-def-editor")).toBeTruthy();` | `expect((await screen.findByDisplayValue("v2-staged-copy"))).toBeTruthy();` | The editor appears after stored authoring is loaded. |
| Unportable | `expect(parseInt(versionInput.value, 10)).toBe(DEF_WITH_STAGES.version + 1);` | No equivalent assertion. | The backend versions pinned bundles; the authoring form has no editable version number to increment. |
| Replacement | `expect(nameInput.value).toBe(DEF_WITH_STAGES.name);` | `expect((await screen.findByDisplayValue("v2-staged-copy"))).toBeTruthy();` | Clone authoring receives a new key instead of preserving the v15 name. Other choices, including implementation capacity, are retained. |
| Unportable | `expect(screen.getByLabelText("Slot binding key")).toBe(keyInput);` | No equivalent assertion. | The pinned high-level authoring form has no slot-binding row; the old input-lookup editor contract is retired. |

The restored detail additionally checks the pinned root scope and visible scope labels. The clone test checks that the generated authoring keeps implementation capacity while assigning a new key.

## `kbbl/core/pwa/oakridge/__tests__/run-session-removal.test.tsx`

The v15 sidebar joined executor attempts with the ACP session inventory and removed deleted session panes. The generated sidebar lists authority executions and opens their owning scopes; it does not identify an ACP session or persist a session pane. The replacement suite checks that a terminal execution opens the right scope and that an empty execution list is explicit. None of those new claims proves the old deletion reconciliation.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Unportable | `expect(visibleSessions()).toEqual(["existing"]);` | No equivalent assertion. | The generated execution row has no `session_id` and is not filtered by the ACP inventory. A deleted ACP session can still have an authority execution. |
| Unportable | `expect(screen.queryByTestId("or-run-pane-session")).toBeNull();` | No equivalent assertion. | The current workspace does not restore saved session panes from the v15 pane store. |
| Unportable | `expect(screen.getByTestId("or-sidebar-session-attempt").textContent).toBe("attempt 2 of 2");` | No equivalent assertion. | The execution row uses worker key and generation, not v15 attempt numbering after purge. |
| Unportable | `expect(visibleSessions()).toEqual(["deleted", "existing"]);` | No equivalent assertion. | Authority executions are projected with scopes; the sidebar does not temporarily show an unknown ACP inventory as a session list. |
| Unportable | `await waitFor(() => expect(visibleSessions()).toEqual(["existing"]));` | No equivalent assertion. | Applying an ACP snapshot does not remove an execution from the authority projection. |
| Unportable | `expect(visibleSessions()).toEqual([]);` | No equivalent assertion. | An empty ACP inventory no longer controls the generated execution list. |
| Unportable | `await waitFor(() => expect(visibleSessions()).toEqual([]));` | No equivalent assertion. | A deletion by another ACP client does not mutate the authority's execution record. The current row links to scope, not a deleted transcript. |

## `kbbl/core/pwa/oakridge/__tests__/run-pane-bodies.test.tsx`

The replacement suite mounts checked artifact review and the existing ACP session surface on the generated route. It retains single-pane transcript and resume behavior. The v15 two-pane workspace and its saved-pane purge contract are explicitly retired. All read-model and ACP snapshot fixtures come from the shared factory. Whitespace in multi-line original assertions is normalized for the table.

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `await waitFor(() => expect(screen.getByTestId("or-run-pane-session")).toBeTruthy());` | `expect(host.getAttribute("data-session-id")).toBe("sid-c1");` | The generated session route still mounts the existing transcript pane. |
| Unportable | `expect(detail.getAttribute("data-review-layout")).toBe("report");` | No equivalent assertion. | Descriptor-driven review layout metadata is absent from the checked revision surface. |
| Unportable | `expect(await screen.findByTestId("or-review-items-section")).toBeTruthy();` | No equivalent assertion. | Review items are attached to collaboration threads, not an independent artifact review-items section. |
| Translated | `expect(screen.getByTestId("or-threads-section")).toBeTruthy();` | `expect(screen.getByTestId("or-artifact-threads")).toBeTruthy();` | The checked artifact review keeps its discussion section. |
| Translated | `expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();` | `expect(screen.getByTestId("or-gate-actions").textContent).toContain("Approve the build");` | An observed pinned command for this revision remains in the artifact review. |
| Translated | `expect(screen.getByTestId("or-decision-approve").textContent).toContain("Approve the build");` | `expect(screen.getByTestId("or-gate-actions").textContent).toContain("Approve the build");` | The visible command retains the authored action label. |
| Replacement | `expect(screen.queryByText("← Back")).toBeNull();` | `expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();` | The review shell has an explicit overview action instead of relying on the old route-level back absence. |
| Unportable | `expect(screen.getByTestId("or-run-pane-close-primary")).toBeTruthy();` | No equivalent assertion. | The current route has one content pane and no primary-pane move/close controls. |
| Unportable | `expect(screen.getByTestId("or-run-pane-move-primary")).toBeTruthy();` | No equivalent assertion. | The current route has one content pane and no primary-pane move/close controls. |
| Translated | `expect(host.getAttribute("data-session-id")).toBe("sid-c1");` | `expect(host.getAttribute("data-session-id")).toBe("sid-c1");` | The embedded pane retains session identity. |
| Translated | `expect(host.querySelector(".events")).toBeTruthy();` | `expect(host.querySelector(".events")).toBeTruthy();` | The existing transcript renderer remains mounted. |
| Translated | `expect(EventSourceStub.instances.some((es) => es.url.includes("sid-c1"))).toBe(true);` | `expect(SessionEvents.instances.some((source) => source.url.includes("sid-c1"))).toBe(true);` | The pane subscribes to the selected session feed. |
| Translated | `expect(surface?.classList.contains("session-surface--embedded")).toBe(true);` | `expect(host.querySelector(".app")?.classList.contains("session-surface--embedded")).toBe(true);` | The input bar is anchored to the embedded session surface. |
| Translated | `expect(host.querySelector(".bottom-stack")).toBeTruthy();` | `expect(host.querySelector(".bottom-stack")).toBeTruthy();` | The input bar belongs to the session pane. |
| Translated | `expect(document.body.querySelectorAll(".bottom-stack")).toHaveLength(1);` | `expect(document.body.querySelectorAll(".bottom-stack")).toHaveLength(1);` | A single route produces one input bar. Two-pane coexistence is separately recorded as lost. |
| Translated | `expect(topBar?.getAttribute("data-chrome")).toBe("pane");` | `expect(topBar?.getAttribute("data-chrome")).toBe("pane");` | The top bar uses pane chrome. |
| Translated | `expect(topBar?.querySelector(".status")).toBeTruthy();` | `expect(topBar?.querySelector(".status")).toBeTruthy();` | Session status remains in the top bar. |
| Translated | `expect(topBar?.querySelector(".session-label-name")?.textContent).toBe("session sid-c1");` | `expect(topBar?.querySelector(".session-label-name")?.textContent).toBe("session sid-c1");` | The selected session name remains visible. |
| Translated | `expect(topBar?.querySelector(".back-button")).toBeNull();` | `expect(topBar?.querySelector(".back-button")).toBeNull();` | The nested session surface omits its own back button. |
| Translated | `expect(topBar?.querySelector(".theme-toggle")).toBeNull();` | `expect(topBar?.querySelector(".theme-toggle")).toBeNull();` | The nested session surface omits its own theme toggle. |
| Unportable | `await waitFor(() => expect(screen.getAllByTestId("or-run-pane-session")).toHaveLength(2));` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(first!.getAttribute("data-session-id")).toBe("sid-c1");` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(second!.getAttribute("data-session-id")).toBe("sid-c2");` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(first!.querySelectorAll(".bottom-stack")).toHaveLength(1);` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(second!.querySelectorAll(".bottom-stack")).toHaveLength(1);` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(first!.contains(second!)).toBe(false);` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `await waitFor(() => expect(screen.getAllByTestId("or-run-pane-session")).toHaveLength(2));` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(send).toBeTruthy();` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(String(send![0])).toBe("/sessions/sid-c2/input");` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(JSON.parse(String(send![1]?.body))).toMatchObject({ text: "status?" });` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `await waitFor(() => expect(screen.getByTestId("or-artifact-detail")).toBeTruthy());` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(screen.getByTestId("or-run-pane-session")).toBeTruthy();` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(screen.getByTestId("or-run-pane-close-primary")).toBeTruthy();` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `expect(screen.getByTestId("or-run-pane-close-secondary")).toBeTruthy();` | No equivalent assertion. | The restored workspace has a single route pane. Independent primary and secondary session/artifact panes, including second-pane send routing, are not available. |
| Unportable | `await waitFor(() => expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).toContain("sid-c1"), );` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `await waitFor(() => expect(screen.getByTestId("or-run-overview")).toBeTruthy());` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(screen.queryByTestId("or-run-pane-session")).toBeNull();` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).not.toContain("sid-c1");` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `await waitFor(() => expect(screen.getByTestId("or-run-overview")).toBeTruthy());` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(rows).toHaveLength(1);` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(rows[0]!.textContent).toContain("c2");` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(screen.queryByTestId("or-run-pane-session")).toBeNull();` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Unportable | `expect(screen.getByTestId("or-run-overview")).toBeTruthy();` | No equivalent assertion. | The current workspace does not persist or reconcile v15 pane entries with ACP removedSids. Generated execution rows link to scopes, so this purge-and-restore claim has no equivalent. |
| Translated | `await waitFor(() => expect(screen.getByTestId("or-run-pane-session").getAttribute("data-session-id")).toBe( "sid-resumed", ), );` | `await waitFor(() => expect(screen.getByTestId("or-run-pane-session").getAttribute("data-session-id")).toBe("sid-resumed"));` | Resuming an ended session replaces the selected transcript in the same generated route pane. |

The current artifact test also checks that the checked build-result viewer renders its summary. This is generated-surface evidence; it does not restore the retired descriptor layout or second pane.

## Remaining `main` suite gap

The following original files are not ported. A similarly named current test, where one exists, does not close the original assertions. These are open coverage gaps, not passing parity claims. The original file and its tests remain available in `main` for the next per-assertion diff.

| Original file | Original tests | Why no assertion-preserving port is present |
| --- | ---: | --- |
| `__tests__/oakridge.test.tsx` | 28 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `__tests__/run-workspace.test.tsx` | 24 | The test targets v15 run, stage, unit, or definition UI built on handwritten models; the restored surface uses scope projections and has no direct test fixture mapping. |
| `components/organisms/BindingEditor.test.tsx` | 6 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-session-availability.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-workspace-restore.test.ts` | 22 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-workspace-storage.test.ts` | 15 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-workspace.test.ts` | 25 | The old run-workspace selector uses v15 stages and units; the current scope workspace exposes a different data model. |

This register covers 7 files and 125 named test declarations as previously counted; parameterized cases may expand further. Ported suites also record source declarations that cannot run on checked projections. None is silently counted as passing.

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
