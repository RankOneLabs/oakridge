# Operator PWA parity evidence

The comparison source is `main` at the start of the c10 parity gate. Each entry
below quotes an assertion from that source and the corresponding assertion in
this branch. **Translated** means the same operator behavior is checked through
the generated read model. **Relaxed** means coverage is weaker. **Unportable**
means the old behavior has no equivalent contract or surface in this branch;
the original assertion is retained here for review rather than silently
deleted. A passing test does not resolve an unportable entry.

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
open parity decisions; no other source file is claimed as ported yet.

## Surface checklist

| Surface | `main` reference | Current light screenshot | Current dark screenshot | Result |
| --- | --- | --- | --- | --- |
| Artifact review | Pending browser walk | Pending browser walk | Pending browser walk | Pending |
| Run overview | Pending browser walk | Pending browser walk | Pending browser walk | Pending |
| Review inbox | Pending browser walk | Pending browser walk | Pending browser walk | Pending |
| Definition list and editor | Pending browser walk | Pending browser walk | Pending browser walk | Pending |
