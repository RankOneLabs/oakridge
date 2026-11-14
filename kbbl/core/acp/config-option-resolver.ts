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
export type OptionMatchKind = IdMatchKind;

export interface ResolvedOption {
  readonly configId: string;
  readonly valueId: string;
  readonly match: OptionMatchKind;
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
  const selector = options.find(
    (option) => option.type === "select" && option.category === category,
  );
  if (!selector || selector.type !== "select") {
    return err(
      `agent exposes no select config option with category "${category}"`,
    );
  }
  const flat = selector.options.flatMap((entry) =>
    "options" in entry ? entry.options : [entry],
  );
  // Models carry a retirement history; effort and mode ids do not. Both paths
  // are the shared transform in core/runtime — this function owns finding the
  // selector and naming the error, nothing about what an id means.
  const matched =
    category === "model"
      ? matchAdvertisedModel(requested, flat)
      : matchAdvertisedId(requested, flat);
  if (matched) {
    return ok({
      configId: selector.id,
      valueId: matched.valueId,
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

