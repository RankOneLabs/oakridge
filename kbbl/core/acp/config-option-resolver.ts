import type * as schema from "@agentclientprotocol/sdk";
import { matchAdvertisedId, matchAdvertisedModel, type IdMatchKind } from "../runtime";
import { acpError, err, ok, type AcpError, type Result } from "./types";

/**
 * How a request was satisfied — the shared `IdMatchKind` from core/runtime,
 * re-exported under the name the ACP surface has always used.
 *
 * `exact` means the agent advertises the id (or display name) that was asked
 * for. The other two mean it does not, and something other than the requested
 * spelling will run: `context_hint_ignored` found the same model in a
 * different context window, `retired_id_mapped` found the alias that replaced
 * a withdrawn id. The caller logs both, because nothing else can tell the
 * operator what changed.
 */
export type OptionMatchKind =
  | IdMatchKind
  /**
   * The requested id is not advertised, but the one option carrying the
   * name recorded when kbbl first applied the model is. A reloaded Claude
   * session offers `claude-fable-5-2` ("Fable 5.2") where the new session
   * offered `fable` ("Fable 5.2").
   */
  | { readonly kind: "applied_name_matched"; readonly appliedName: string };

export interface ResolvedOption {
  readonly configId: string;
  readonly valueId: string;
  /** The agent's display name for `valueId` (SessionConfigSelectOption.name). */
  readonly valueName: string;
  readonly match: OptionMatchKind;
}

/**
 * A session's model request: the id it asked for, and the agent's name for
 * the option that id resolved to when kbbl last applied it (null before the
 * first application).
 */
export interface ModelRequest {
  readonly requested_model: string | null;
  readonly applied_model_name: string | null;
}

/**
 * Pure resolver for requested model/effort against the agent's config
 * options (§12): first select option in the semantic category, matched by
 * value id or normalized display name. Returns null when nothing was
 * requested; an error when a request cannot be satisfied.
 *
 * **The agent's model vocabulary is not a constant.** The same pinned binary
 * advertises different ids from one `session/new` to the next as the 1M
 * context entitlement comes and goes — `opus[1m]` and `opus` are each
 * sometimes the only opus on offer, and likewise `claude-fable-5-1[1m]` and
 * `claude-fable-5-1`. Matching those ids strictly means a launch button that
 * works all morning and kills the session before its first turn in the
 * afternoon, so the context hint is the last thing compared and the first
 * thing dropped: a hint mismatch changes the window, which beats not running.
 */
export function resolveRequestedOption(
  options: readonly schema.SessionConfigOption[],
  category: "model" | "thought_level",
  requested: string | null,
): Result<ResolvedOption | null, AcpError> {
  if (requested === null) return ok(null);
  const code =
    category === "model"
      ? ("requested_model_unsupported" as const)
      : ("requested_effort_unsupported" as const);
  const matched = matchRequestedOption(options, category, requested);
  if (!matched.ok) {
    return err(acpError(code, "resolveRequestedOption", matched.error));
  }
  return matched;
}

/**
 * Resolves a session's model request. The recorded name comes first: it is
 * what this session already ran, and a reload advertises that model under a
 * different id than the alias it was created with. Without a recorded name,
 * or when it matches no single option, the requested id resolves as usual.
 */
export function resolveRequestedModel(
  options: readonly schema.SessionConfigOption[],
  request: ModelRequest,
): Result<ResolvedOption | null, AcpError> {
  if (request.requested_model === null) return ok(null);
  const byName = matchAppliedModelName(options, request);
  if (byName !== null) return ok(byName);
  const resolved = resolveRequestedOption(options, "model", request.requested_model);
  if (resolved.ok || request.applied_model_name === null) return resolved;
  return err(acpError(
    "requested_model_unsupported",
    "resolveRequestedModel",
    `${resolved.error.detail}, and no single option is named "${request.applied_model_name}"`,
  ));
}

/** The one model option whose name equals the recorded name, or null. */
function matchAppliedModelName(
  options: readonly schema.SessionConfigOption[],
  request: ModelRequest,
): ResolvedOption | null {
  const { requested_model, applied_model_name } = request;
  if (applied_model_name === null) return null;
  const selector = findSelector(options, "model");
  if (selector === null) return null;
  const named = flattenSelectOptions(selector).filter((entry) => entry.name === applied_model_name);
  const [only] = named;
  if (named.length !== 1 || only === undefined) return null;
  return {
    configId: selector.id,
    valueId: only.value,
    valueName: only.name,
    match: only.value === requested_model
      ? { kind: "exact" }
      : { kind: "applied_name_matched", appliedName: applied_model_name },
  };
}

type SelectConfigOption = Extract<schema.SessionConfigOption, { type: "select" }>;

/** The first select option in a semantic category, or null. */
function findSelector(
  options: readonly schema.SessionConfigOption[],
  category: RequestedOptionCategory,
): SelectConfigOption | null {
  const selector = options.find(
    (option) => option.type === "select" && option.category === category,
  );
  return selector?.type === "select" ? selector : null;
}

/** A select option's values with any grouping removed. */
function flattenSelectOptions(selector: SelectConfigOption): schema.SessionConfigSelectOption[] {
  return selector.options.flatMap((entry) => ("options" in entry ? entry.options : [entry]));
}

/** Semantic config-option categories kbbl resolves requests against (§12). */
export type RequestedOptionCategory = "model" | "thought_level" | "mode";

/**
 * Pure matcher behind every §12 request: the first select option in the
 * category, matched by value id or normalized display name. The error is a
 * human-readable detail; callers decide whether a miss is fatal (model,
 * effort) or advisory (mode).
 */
export function matchRequestedOption(
  options: readonly schema.SessionConfigOption[],
  category: RequestedOptionCategory,
  requested: string,
): Result<ResolvedOption, string> {
  const selector = findSelector(options, category);
  if (selector === null) {
    return err(
      `agent exposes no select config option with category "${category}"`,
    );
  }
  const flat = flattenSelectOptions(selector);
  // Models carry a retirement history; effort and mode ids do not. Both paths
  // are the shared transform in core/runtime — this function owns finding the
  // selector and naming the error, nothing about what an id means.
  const matched =
    category === "model"
      ? matchAdvertisedModel(requested, flat)
      : matchAdvertisedId(requested, flat);
  const matchedOption = matched ? flat.find((entry) => entry.value === matched.valueId) : undefined;
  if (matched && matchedOption) {
    return ok({
      configId: selector.id,
      valueId: matched.valueId,
      valueName: matchedOption.name,
      match: matched.match,
    });
  }
  return err(
    `no option matching "${requested}" in config option "${selector.id}"`,
  );
}

/** The semantic category of a config option id, or null when it has none. */
export function configOptionCategory(
  options: readonly schema.SessionConfigOption[],
  configId: string,
): string | null {
  return options.find((option) => option.id === configId)?.category ?? null;
}

