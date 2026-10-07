import type { WorkerDefinition } from "../../../source-contracts";
import { reference } from "../../../primitives/expressions";

export const workers: WorkerDefinition[] = [
  {
    key: "preparation",
    result_schema: "repo_result",
    exclusive: true,
    actions: [
      {
        key: "prepare",
        operation: "repository.prepare",
        contract_version: 1,
        input_schema: "repo_input",
        input: reference({ kind: "input" }, []),
        prompt: null,
        settings: [{ key: "result_fact", value: "prepared" }],
        tools: [],
        outputs: [],
        deadline_ms: 60000,
        max_attempts: 2
      }
    ]
  }
];
