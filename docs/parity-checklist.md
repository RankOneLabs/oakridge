# Operator PWA parity evidence

The comparison source is `main` at the start of the c10 parity gate. Each entry
below quotes an assertion from that source and the corresponding assertion in
this branch. **Translated** means the same operator behavior is checked through
the generated read model. **Relaxed** means coverage is weaker. **Unportable**
means the old behavior has no equivalent contract or surface in this branch;
the original assertion is retained here for review rather than silently
deleted. A passing test does not resolve an unportable entry.

This branch ports 10 of the 48 `main` PWA test files. The remaining 38 are
listed below as an explicit coverage gap; this is not a completed parity gate.

## `kbbl/core/pwa/oakridge/__tests__/artifact-review.test.tsx`

| Classification | Original assertion (`main`) | New assertion | Reason |
| --- | --- | --- | --- |
| Translated | `expect(screen.getByTestId("or-artifact-type").textContent).toBe("spec_v2");` | `expect(screen.getByTestId("or-artifact-review").textContent).toContain("analysis");` | The generated projection identifies the output by `output_key`; `type_id` is not in the current artifact revision contract. The same review heading identifies the artifact being read. |
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
| Translated | `expect(await screen.findByTestId("or-artifact-detail-error")).toBeTruthy();` | `expect(screen.getByRole("status").textContent).toContain("unavailable in the current scope projection");` | The current review consumes the already loaded scope projection and exposes an explicit missing-revision state. Fetch failure remains the responsibility of the scope loader. |
| Translated | `expect(screen.queryByText("← Back")).toBeNull();` | `expect(screen.getByRole("button", { name: "← Overview" })).toBeTruthy();` | Review navigation is now an explicit overview action on the review shell. This is a changed interaction, so the old absence assertion cannot be preserved literally. |

The first suite has 4 passing tests. The unportable assertions above remain
open parity decisions.

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
| Unportable | `expect(selectStableDecisionQueue([live("a"), live("b"), live("c")], [gate("b"), gate("c")])).toEqual([{ kind: "settled", item: gate("a") }, live("b"), live("c")]);` | No equivalent assertion. | The generated inbox has no stable settled-row model; the current queue derives live commands from scopes. This loss of row position coverage remains open. |
| Unportable | `expect(selectStableDecisionQueue([live("a"), live("b")], [gate("assessment"), gate("a"), gate("b")])).toEqual([live("a"), live("b"), live("assessment")]);` | No equivalent assertion. | The current selector does not retain previous rows between projections. |
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
| `client.test.ts` | 8 | The old run, session, and gate endpoints and event frame parser were replaced by scope commands and generated projections; the existing same-name suite exercises different client behavior. |
| `components/molecules/AssessmentViewer.test.tsx` | 5 | The old viewer cross-references brief and build result, numbers unmet criteria, and folds met criteria; the current checked viewer receives only the assessment body. |
| `components/molecules/BuildBriefViewer.test.tsx` | 4 | The old atom-edit toggle and RFC-6901 edit callbacks are absent from the restored viewer. |
| `components/molecules/BuildResultViewer.test.tsx` | 5 | The old viewer cross-references a brief for out-of-scope files and acceptance criteria; the current checked viewer receives only one body. |
| `components/molecules/ExpandableText.test.tsx` | 2 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `components/molecules/SpecAnalysisViewer.test.tsx` | 6 | The old blocker callout, source toggle, and untyped validation alert are absent; current checked-schema content needs a separate parity decision. |
| `components/organisms/BindingEditor.test.tsx` | 6 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `hooks/useOakridgeRunEventStream.test.tsx` | 1 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/assessment.test.ts` | 13 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/brief-notes.test.ts` | 15 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/build-brief.test.ts` | 2 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/build-result.test.ts` | 8 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/cohort-artifact.test.ts` | 13 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/launch-config.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/launch-selection.test.ts` | 4 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/plan.test.ts` | 8 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/pr-summary.test.ts` | 6 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/request-identity.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-accent.test.ts` | 5 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-activity.test.ts` | 4 | The tested v15 module is absent in this branch; its behavior needs an explicit replacement-surface decision before assertions can be translated. |
| `lib/run-notifications.test.ts` | 2 | The existing same-name suite uses current scope notifications; the two old run-event assertions have not been mapped to that projection. |
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

This register covers 38 files and 362 named test declarations; parameterized cases may expand further. None is silently counted as ported.

## Surface checklist

The browser test serves the production PWA bundle through stub kbbl, routes its API calls to the production Oakridge composition, and uses a stub forge. Each row has a light and dark capture from that walk. The historical `main` surface has no runnable backend in this branch, so the per-file assertion diff above is the available baseline; these captures establish current rendering, not visual equality with `main`.

| Surface | `main` reference | Current light screenshot | Current dark screenshot | Result |
| --- | --- | --- | --- | --- |
| Run overview | `main` run-workspace tests | [light](parity-screenshots/run-overview-light.png) | [dark](parity-screenshots/run-overview-dark.png) | Rendered in production bundle |
| Artifact review | `main` artifact-review tests and assertion diff above | [light](parity-screenshots/artifact-review-light.png) | [dark](parity-screenshots/artifact-review-dark.png) | Operator edit revision rendered |
| Artifact discussion | `main` artifact-review tests | [light](parity-screenshots/artifact-discussion-light.png) | [dark](parity-screenshots/artifact-discussion-dark.png) | Ping delivered to the completed stub session |
| Review inbox | `main` ReviewInboxView tests | [light](parity-screenshots/review-inbox-light.png) | [dark](parity-screenshots/review-inbox-dark.png) | Rendered in production bundle |
| Definition list | [`main` workflow list capture](../kbbl/docs/c1-before-workflow-def-list.png) and workflowdefs tests | [light](parity-screenshots/definitions-light.png) | [dark](parity-screenshots/definitions-dark.png) | Rendered in production bundle; old list is a different workflow model |
| Definition editor | `main` workflowdefs tests | [light](parity-screenshots/definition-editor-light.png) | [dark](parity-screenshots/definition-editor-dark.png) | Rendered in production bundle |

The edit-then-ping test checks that the edited revision has a null `execution_id` and points back to the agent revision. It then creates a discussion thread, sends a reply with Ping agent selected, and checks `delivered`, one resume of the already completed stub session, and the exact input received by stub kbbl. The edit is sent from the browser through the operator command API because the restored review surface does not expose an edit control.
