// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.
// The PWA intentionally imports no backend source at runtime or typecheck time.

import type { OperatorForgeRepository } from "../storage/json-column-types";

export interface OperatorProjectDraft {
  readonly name: string;
  readonly repo_dir: string;
  readonly forge_repository: OperatorForgeRepository | null;
  readonly integration_branch: string | null;
}
