import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import YAML from "yaml";

// integration_pr requires study-specific input, assessment validation,
// integrator, and integration_review declarations. Those paths are excluded.
const SHARED_DECLARATIONS: readonly string[][] = [
  ["stages", "prepare"],
  ["workers", "pr_watch"],
  ["reviews", "pr_closed"],
  ["stages", "integration", "let"],
  ["stages", "integration", "artifacts", "pr"],
  ["stages", "integration", "artifacts", "pr_state"],
  ["stages", "integration", "artifacts", "manual_merge_target"],
  ["stages", "integration", "artifacts", "observed_state"],
  ["stages", "integration", "workers", "pr_watch"],
  ["stages", "integration", "workers", "prepare_manual_merge"],
  ["stages", "integration", "workers", "prepare_observed_state"],
  ["stages", "integration", "reviews", "merge_confirmation"],
  ["stages", "integration", "reviews", "pr_closed"],
  ["stages", "integration", "done_when"],
  ["stages", "integration", "outcome"],
];

const development = YAML.parseDocument(readFileSync(new URL("../development.yaml", import.meta.url), "utf8"));
const study = YAML.parseDocument(readFileSync(new URL("../study.yaml", import.meta.url), "utf8"));

for (const path of SHARED_DECLARATIONS) {
  test(`study shares development's ${path.join(".")}`, () => {
    expect(development.hasIn(path)).toBe(true);
    expect(study.getIn(path, true)).toBeDefined();
    const studyDeclaration = study.getIn(path, true);
    const developmentDeclaration = development.getIn(path, true);
    expect(YAML.isNode(studyDeclaration) && studyDeclaration.toJS(study)).toEqual(
      YAML.isNode(developmentDeclaration) && developmentDeclaration.toJS(development),
    );
  });
}
