import fixture from "./v2-definition-detail.json";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";

/** The shared prompt both brief writer modes include, as the authority reports it. */
export const SHARED_PROMPT = "shared/raise-blocker.md";
const base = fixture.definition as unknown as OperatorDefinitionDetail;
const including = (path: string) => ({ ...base.prompts[path], body: `${base.prompts[path].body}\n{{> ${SHARED_PROMPT}}}\n`, includes: [SHARED_PROMPT] });

/** The development definition with its brief writer prompts including one shared prompt. */
export const definitionWithIncludes: OperatorDefinitionDetail = { ...base, prompts: { ...base.prompts,
  "development/brief.md": including("development/brief.md"),
  "development/brief-revise.md": including("development/brief-revise.md"),
  [SHARED_PROMPT]: { body: "Raise a blocker instead of guessing.\n", digest: "b".repeat(64), includes: [] },
} };
