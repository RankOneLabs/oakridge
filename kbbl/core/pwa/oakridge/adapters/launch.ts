import type { OperatorLaunchRequest } from "../operator-contracts/http/ingress";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { CreateRunRequest } from "../launch-types";
import { selectAgentSessionTargets } from "../lib/agent-session-targets";
import { indexProjectedSchemas, matchesProjectedSchema } from "../lib/projected-schema";
import { fail, ok, type AdapterResult } from "./core";

export function workflowLaunch(body: CreateRunRequest, definition: OperatorDefinitionDetail, requestId: string): AdapterResult<OperatorLaunchRequest> {
  const root = definition.bundle.units.find((unit) => unit.key === definition.bundle.root);
  if (!root || !matchesProjectedSchema(indexProjectedSchemas(definition.bundle.schemas), root.input_schema, body.workflow_input))
    return fail("create run", "Input does not match the workflow's launch schema.");
  const targets = selectAgentSessionTargets(definition.workflow, definition.graph, definition.worker_names);
  for (const target of targets) {
    const stage = Object.hasOwn(body.session_settings, target.stage) ? body.session_settings[target.stage] : undefined;
    const choice = stage && Object.hasOwn(stage, target.worker) ? stage[target.worker] : undefined;
    if (!choice?.harness || !choice.model.trim()) return fail("create run", `missing session settings for ${target.label}`);
  }
  const declaredKeys = new Set(targets.map((target) => target.key));
  for (const [stage, workers] of Object.entries(body.session_settings)) {
    if (Object.keys(workers).length === 0) return fail("create run", `unknown agent stage ${stage}`);
    for (const worker of Object.keys(workers)) {
      if (!declaredKeys.has(JSON.stringify([stage, worker]))) return fail("create run", `unknown agent worker ${stage} · ${worker}`);
    }
  }
  return ok({ request_id: requestId, definition_id: definition.definition_id, project_id: body.project_id,
    input: body.workflow_input, config: { sessions: body.session_settings, grading_enabled: body.grading_enabled } });
}
