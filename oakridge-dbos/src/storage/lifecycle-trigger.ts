import type { CheckedValue, DefinitionBundle, LifecyclePayloadProjection, Trigger } from "../core-client/generated-contracts";
import type { CoreClient } from "../core-client/client";
import type { Result } from "./commit";

export interface LifecycleTriggerInput {
  readonly core: CoreClient;
  readonly bundle: DefinitionBundle;
  readonly id: string;
  readonly key: string;
  readonly schema: string;
  readonly projection?: LifecyclePayloadProjection;
  readonly reason?: string;
  readonly supplied_payload?: unknown;
  readonly has_supplied_payload?: boolean;
}

export function projectLifecyclePayload(projection: LifecyclePayloadProjection | undefined, reason: string | undefined): Result<unknown> {
  switch (projection?.kind ?? "empty_record") {
    case "empty_record": return { ok: true, value: {} };
    case "reason": return reason === undefined
      ? { ok: false, error: { operation: "project_lifecycle_payload", entity_id: "reason", detail: "configured reason is absent" } }
      : { ok: true, value: reason };
  }
}

/** The single typed boundary for operator, dependency, parent and completion triggers. */
export async function prepareLifecycleTrigger(input: LifecycleTriggerInput): Promise<Result<Trigger>> {
  const projected = input.has_supplied_payload ? { ok: true as const, value: input.supplied_payload }
    : projectLifecyclePayload(input.projection, input.reason);
  if (!projected.ok) return projected;
  const checked = await input.core.request("validate_payload", { bundle: input.bundle, schema: input.schema, payload: projected.value });
  if (!checked.ok) return { ok: false, error: { operation: "prepare_lifecycle_trigger", entity_id: input.id, detail: JSON.stringify(checked.error) } };
  if (checked.value.kind !== "validated") return { ok: false, error: { operation: "prepare_lifecycle_trigger", entity_id: input.id, detail: "core returned no validated payload" } };
  const payload: CheckedValue = checked.value.value;
  return { ok: true, value: { id: input.id, key: input.key, payload } };
}
