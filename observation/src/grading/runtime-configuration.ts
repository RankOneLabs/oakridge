import type { ProducerProfile } from "../ports/producer-profile";
import { NO_CONFIGURED_GRADERS, type GraderCapability } from "../http/health";
import type { CaptureConfiguration } from "./evidence";
import type { GradingRegistration } from "./configuration";

export interface RuntimeSnapshot {
  readonly version: number | null;
  readonly hash: string | null;
  readonly registration: GradingRegistration;
  readonly profile: ProducerProfile;
  readonly capture_configuration: CaptureConfiguration;
  readonly grader_capability: GraderCapability;
  readonly applied_at: string;
}
export interface RuntimeSnapshotInput {
  readonly version: number | null;
  readonly hash: string | null;
  readonly registration: GradingRegistration;
  readonly profile: ProducerProfile;
  readonly applied_at: string;
}
export const graderCapability = (registration: GradingRegistration): GraderCapability => registration.graders.length === 0
  ? NO_CONFIGURED_GRADERS : { state: "configured", graders: registration.graders.map((grader) => ({ runner: grader.runner,
    evaluator_definition_id: grader.evaluator_definition_id })) };

export const runtimeSnapshot = (input: RuntimeSnapshotInput): RuntimeSnapshot => ({ ...input,
  capture_configuration: input.registration.capture, grader_capability: graderCapability(input.registration) });

/** Copy and freeze data; injected schema instances and functions keep their own lifecycle. */
function immutable<T>(value: T): T {
  if (Array.isArray(value)) return Object.freeze(value.map(immutable)) as T;
  if (value !== null && typeof value === "object" && Object.getPrototypeOf(value) === Object.prototype)
    return Object.freeze(Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, immutable(entry)]))) as T;
  return value;
}

/** One reference swap applies a complete configuration to subsequent requests and reconciliations. */
export class RuntimeConfiguration {
  private snapshot: RuntimeSnapshot;
  constructor(snapshot: RuntimeSnapshot) { this.snapshot = immutable(snapshot); }
  current(): RuntimeSnapshot { return this.snapshot; }
  replace(snapshot: RuntimeSnapshot): void { this.snapshot = immutable(snapshot); }
}
