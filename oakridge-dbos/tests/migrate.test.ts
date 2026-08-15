import { expect, test } from "bun:test";

import { migrationNames } from "../src/storage/migrate";

test("migration discovery accepts only numbered SQL files in deterministic order", () => {
  expect(migrationNames(["notes.md", "0003_artifact_lifecycle.sql", "0002_workflow_attempt.sql", "0001_domain.sql", "1_bad.sql", "0003-UP.sql"]))
    .toEqual(["0001_domain.sql", "0002_workflow_attempt.sql", "0003_artifact_lifecycle.sql"]);
});
