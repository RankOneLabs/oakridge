import type { JsonValue } from "./primitives";

/**
 * The bag of values a run's `context` bindings read out of.
 *
 * It was `JsonValue` end to end — `POST /workflow_runs` accepted any JSON
 * whatsoever, `prepareRunContext` took and returned `JsonValue`, and the first
 * participant with an opinion about the shape was a JSON pointer three stages
 * deep failing on `context pointer '/oakridge_url' not found`. So a
 * misconfigured launch was discovered one stage per run, by the operator,
 * mid-flight.
 *
 * What is fixed here is only the shape that makes a pointer meaningful at all:
 * a context is a JSON *object*. The keys stay open on purpose — a definition is
 * authored, and an authored definition may read any pointer it likes, so an
 * exhaustive key list here would be a second definition of the contract that
 * drifts from the first. Which keys a *particular* run must carry is a question
 * only its workflow definition can answer; see `contextRequirementsOf`.
 */
export type RunContext = { readonly [key: string]: JsonValue };

/** A context, or nothing — arrays and scalars are not contexts. */
export const isRunContext = (value: JsonValue): value is RunContext =>
  typeof value === "object" && value !== null && !Array.isArray(value);
