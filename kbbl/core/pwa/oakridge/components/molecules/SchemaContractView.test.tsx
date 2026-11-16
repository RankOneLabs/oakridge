import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { SchemaContractView } from "./SchemaContractView";
import { CONTRACT_RENDERERS, resolveContractRenderer } from "../../artifactRegistry";
afterEach(cleanup);
test("generic contracts mark record fields and terminate recursive references", () => {
  render(<SchemaContractView definition_id="test" schemas={{node: {kind: "record", fields: {child: {kind: "named", schema: "node"}}}}} schema={{kind: "record", fields: {title: {kind: "text"}, notes: {kind: "optional", value: {kind: "text"}}, tree: {kind: "named", schema: "node"}}}} />);
  expect(screen.getByText("title · required")).toBeTruthy();
  expect(screen.getByText("notes · optional")).toBeTruthy();
  expect(screen.getAllByText("node").length).toBeGreaterThan(0);
});
test("contract registry falls back by kind and isolates overrides", () => {
  const kinds = ["document", "record", "external_reference", "assessment", "status_record"] as const;
  for (const kind of kinds) expect(resolveContractRenderer(kind)).toBe(SchemaContractView);
  const custom = () => <p>custom</p>;
  CONTRACT_RENDERERS.record = custom;
  try {
    expect(resolveContractRenderer("record")).toBe(custom);
    expect(resolveContractRenderer("document")).toBe(SchemaContractView);
  } finally { delete CONTRACT_RENDERERS.record; }
});

test("a newly declared artifact renders a definition contract from its schema", async () => {
  const { StageInspector } = await import("./StageInspector");
  const fixture = await import("../../__fixtures__/v2-definition-detail.json");
  const detail = structuredClone(fixture.definition) as unknown as import("../../operator-contracts/projections/definition-view").OperatorDefinitionDetail;
  const stage = detail.effective_workflow.stages.brief;
  const release_note = {kind: "record", schema: {kind: "record", fields: {title: {kind: "text"}, notes: {kind: "optional", value: {kind: "text"}}}}} as const;
  stage.workers.writer.produces.push("release_note");
  render(<StageInspector definition={{...detail, effective_workflow: {...detail.effective_workflow, stages: {...detail.effective_workflow.stages, brief: {...stage, artifacts: {...stage.artifacts, release_note}}}}}} selection={{kind: "stage", stage: "brief", tab: "artifacts"}} />);
  const article = within(screen.getByRole("region", {name: "Artifacts"})).getByRole("heading", {name: "release_note"}).closest("article");
  expect(article?.textContent).toContain("Definition contract");
  expect(article?.textContent).toContain("title · required");
  expect(article?.textContent).toContain("notes · optional");
});
