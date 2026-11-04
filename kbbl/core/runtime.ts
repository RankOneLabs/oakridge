// Runtime identity + launch/config surface (§12, §20.2).
//
// The provider-adapter contract (AgentRuntime, RuntimeRegistry,
// classifyEvent, the RuntimeEvent union, the conformance harness) is gone
// with the legacy per-session state machine — the ACP substrate
// (core/acp/*) replaced it, and no adapter ever implemented this contract
// against ACP. What survives here is the small vocabulary the launch and
// config surfaces still use directly: which runtime ids exist, their
// descriptors (label/models/efforts), and default-model lookup.

export type RuntimeId = "claude-code" | "codex";

export function isRuntimeId(value: unknown): value is RuntimeId {
  return value === "claude-code" || value === "codex";
}

/**
 * A context-window hint carried by a model id — the `1m` of `opus[1m]`.
 *
 * Claude Code spells the same model both ways depending on whether the 1M
 * entitlement is live, so every comparison of a requested id against an
 * advertised one has to be able to look past the hint. Defined here beside
 * the vocabulary it describes; `resolveRequestedOption` is the consumer.
 */
const CONTEXT_HINT_PATTERN = /\[(\d+[mk])\]$/i;

/** `opus[1m]` → `opus`; ids without a hint are returned unchanged. */
export function withoutContextHint(value: string): string {
  return value.replace(CONTEXT_HINT_PATTERN, "");
}

export function contextHintOf(value: string): string | null {
  return value.match(CONTEXT_HINT_PATTERN)?.[1]?.toLowerCase() ?? null;
}

export interface RuntimeDescriptor {
  id: RuntimeId;
  label: string;
  models: readonly { value: string; label: string }[];
  /**
   * Reasoning/effort levels this runtime accepts, most-effort-last. Empty for
   * runtimes with no effort control. The PWA renders these as an effort picker
   * (prepending a "default" = unset option) exactly as it does `models`. Values
   * differ per runtime (CC: low..max; Codex: low..ultra), so each adapter
   * advertises its own set rather than sharing a global enum.
   */
  efforts: readonly { value: string; label: string }[];
  supportsCompaction: boolean;
}

export interface RuntimeOption {
  readonly value: string;
  readonly label: string;
}

/**
 * Built-in choices used by the single-session launcher and Oakridge v2's
 * planner/worker pickers before a session exists. Once a session has started,
 * the agent's ACP config options are authoritative and may be more specific to
 * the operator's account or configuration.
 *
 * **These values are the pinned agent's own option ids, not marketing model
 * names.** `resolveRequestedOption` (core/acp/controller.ts) matches a
 * requested model/effort against the agent's advertised `configOptions` by
 * exact value id or exact display name, and a miss fails provisioning with
 * `requested_model_unsupported` — the session dies before its first turn. A
 * picker entry the pinned agent does not advertise is therefore not a
 * cosmetic nicety, it is a launch button that always fails.
 *
 * **The Claude entries are family aliases, and that is deliberate.** The
 * installed CLI advertises `opus`/`fable`/`sonnet`/`haiku` as the current
 * member of each family alongside explicit older ids (`claude-opus-5`,
 * `claude-sonnet-5`, `claude-haiku-4-5-20251001`, `claude-fable-5`). Picking
 * the alias means a model generation that ships upstream reaches operators
 * without a kbbl release; picking the explicit id would pin kbbl to a
 * specific generation forever, which is how `sonnet 5`/`haiku 4.5` sat in
 * this list after the account was already entitled to 5.5. The labels name
 * what the alias resolves to today, so they are expected to move with the
 * ids rather than stay fixed.
 *
 * `claude-fable-5-1` is gone from this list because the installed CLI does
 * not advertise it — `fable` is the only route to Fable 5.1 there. Rows and
 * browsers still holding it are mapped forward by LEGACY_MODEL_ALIASES.
 *
 * The Claude ids here are deliberately hintless (`opus`, not `opus[1m]`).
 * The agent advertises the two interchangeably depending on whether the 1M
 * context entitlement is live, so the resolver treats a context hint as
 * droppable and matches either way; asking without one just means kbbl is
 * not the thing requesting the bigger window. Stored selections still
 * carrying `opus[1m]` from before keep resolving — no migration needed.
 *
 * Both lists are pinned to the agent versions in kbbl/package.json and
 * guarded two ways: `runtime-vocabulary.test.ts` checks every entry resolves
 * against a recorded vocabulary variant, and the opt-in
 * real-agent smoke test checks the installed binary still answers with one
 * of those variants. Bumping `@agentclientprotocol/*` means re-running the
 * smoke test and updating both the fixture and these lists together — the
 * ids do drift (0.70.0's `claude-fable-5[1m]` became 0.76.0's
 * `claude-fable-5-1[1m]`).
 *
 * Each agent also advertises a "default" option; kbbl expresses that as an
 * unset (null) model/effort instead, so it is deliberately not listed here.
 */
export const RUNTIME_MODELS: Readonly<Record<RuntimeId, readonly RuntimeOption[]>> = {
  // @agentclientprotocol/claude-agent-acp 0.76.0, config option `model`.
  "claude-code": [
    { value: "opus", label: "opus 5.5" },
    { value: "fable", label: "fable 5.1" },
    { value: "sonnet", label: "sonnet 5.5" },
    { value: "haiku", label: "haiku 5.5" },
  ],
  // @agentclientprotocol/codex-acp 1.13.0 driving the installed codex CLI,
  // config option `model`. `gpt-5.5` is gone: codex-acp fetches this list
  // from its app server rather than a local catalog, and the server retired
  // the model, so the entry was a launch button that could only fail.
  codex: [
    { value: "gpt-6.1-sol", label: "gpt-6.1 sol" },
    { value: "gpt-6-astra", label: "gpt-6 astra" },
    { value: "gpt-6.1-terra", label: "gpt-6.1 terra" },
    { value: "gpt-6-sol", label: "gpt-6 sol" },
    { value: "gpt-6-luna", label: "gpt-6 luna" },
    { value: "gpt-5.6-sol", label: "gpt-5.6 sol" },
    { value: "gpt-5.6-terra", label: "gpt-5.6 terra" },
    { value: "gpt-5.6-luna", label: "gpt-5.6 luna" },
  ],
};

export const RUNTIME_EFFORTS: Readonly<Record<RuntimeId, readonly RuntimeOption[]>> = {
  // claude-agent-acp 0.76.0, config option `effort`.
  "claude-code": [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
  ],
  // codex-acp 1.13.0, config option `reasoning_effort`.
  codex: [
    { value: "low", label: "low" },
    { value: "medium", label: "medium" },
    { value: "high", label: "high" },
    { value: "xhigh", label: "xhigh" },
    { value: "max", label: "max" },
    { value: "ultra", label: "ultra" },
  ],
};

export type RuntimeModelSelection = {
  runtime: RuntimeId;
  model: string;
  /**
   * Reasoning/effort level for this role's sessions. Omitted / null means "no
   * override — use the runtime default", mirroring standalone sessions. Model
   * defaults are pinned per runtime; effort has no convention worth forcing.
   */
  effort?: string | null;
};

const DEFAULT_MODEL_BY_RUNTIME: Record<RuntimeId, string> = {
  "claude-code": "opus",
  codex: "gpt-5.6-sol",
};

export function defaultModelForRuntime(runtimeId: RuntimeId): string {
  return DEFAULT_MODEL_BY_RUNTIME[runtimeId];
}

export function defaultPlannerModelForRuntime(runtimeId: RuntimeId): string {
  return defaultModelForRuntime(runtimeId);
}

export function defaultWorkerModelForRuntime(runtimeId: RuntimeId): string {
  return defaultModelForRuntime(runtimeId);
}

/**
 * Explicit ids the picker used to carry, mapped to the family alias that now
 * names the same model.
 *
 * **This is a browser-compatibility shim with an expiry, not a vocabulary.**
 * Neither database holds a retired id — `acp_sessions.requested_model` and
 * `authority.run.config` were both checked and carry only family aliases and
 * currently advertised codex ids, and no pinned workflow definition declares
 * a model at all. The one store that cannot be migrated is `localStorage`,
 * where a browser that picked Fable before the picker moved to the `fable`
 * alias still holds `claude-fable-5-1`. When no such browser can plausibly
 * remain, delete this map and `matchAdvertisedModel` with it.
 *
 * Only same-model renames belong here. `claude-opus-5` is **not** an alias of
 * `opus` — the CLI advertises both, and they are different generations, so
 * mapping one to the other would silently change an operator's model.
 */
const RETIRED_MODEL_IDS: Readonly<Record<string, string>> = {
  "claude-fable-5-1": "fable",
};

/** An id as an agent advertises it, with its display name where there is one. */
export interface AdvertisedOption {
  readonly value: string;
  readonly name?: string;
}

/** How a requested id was matched to an advertised one. */
export type IdMatchKind =
  | { readonly kind: "exact" }
  | {
      readonly kind: "context_hint_ignored";
      readonly requestedHint: string | null;
      readonly matchedHint: string | null;
    }
  | { readonly kind: "retired_id_mapped"; readonly retiredId: string };

export interface AdvertisedMatch {
  readonly valueId: string;
  readonly match: IdMatchKind;
}

/**
 * The advertised id a requested one means, or null when none of them does.
 *
 * **This is the single answer to that question.** It used to be three: the ACP
 * resolver, the PWA's stored-model matcher and the role-selection staleness
 * check each reimplemented it, they drifted, and a retired id that two of them
 * mapped killed sessions through the third. Every caller goes through here or
 * through `matchAdvertisedModel`.
 *
 * Exact id wins, then exact display name — agents spell the same model as an
 * id in one place and a label in another. Failing both, the context-window
 * hint is dropped and the same family accepted: `opus[1m]` and `opus` are one
 * pick that agents advertise interchangeably as an entitlement comes and
 * goes. The hintless spelling is preferred when several are on offer, so the
 * result does not depend on advertised order.
 */
export function matchAdvertisedId(
  requested: string,
  candidates: readonly AdvertisedOption[],
): AdvertisedMatch | null {
  const normalized = requested.trim().toLowerCase();
  const exact = candidates.find(
    (candidate) =>
      candidate.value === requested ||
      candidate.value.toLowerCase() === normalized ||
      candidate.name?.trim().toLowerCase() === normalized,
  );
  if (exact) return { valueId: exact.value, match: { kind: "exact" } };

  const family = withoutContextHint(normalized);
  const relatives = candidates.filter(
    (candidate) => withoutContextHint(candidate.value.toLowerCase()) === family,
  );
  const relative =
    relatives.find((candidate) => contextHintOf(candidate.value) === null) ??
    relatives[0];
  if (!relative) return null;
  return {
    valueId: relative.value,
    match: {
      kind: "context_hint_ignored",
      requestedHint: contextHintOf(normalized),
      matchedHint: contextHintOf(relative.value),
    },
  };
}

/**
 * As `matchAdvertisedId`, plus one last resort for models: an id the vendor
 * has retired in favour of the alias that replaced it.
 *
 * Deliberately last. The map is consulted only once a requested id matches
 * nothing advertised, so it can never shadow a live id — including the
 * generation-pinned ones the agent still offers beside its aliases. Effort and
 * mode ids have no retirement history and do not come through here.
 */
export function matchAdvertisedModel(
  requested: string,
  candidates: readonly AdvertisedOption[],
): AdvertisedMatch | null {
  const direct = matchAdvertisedId(requested, candidates);
  if (direct) return direct;
  const retiredId = requested.trim();
  const replacement = RETIRED_MODEL_IDS[withoutContextHint(retiredId.toLowerCase())];
  if (replacement === undefined) return null;
  const mapped = matchAdvertisedId(replacement, candidates);
  if (!mapped) return null;
  return { valueId: mapped.valueId, match: { kind: "retired_id_mapped", retiredId } };
}

/**
 * Whether a stored selection still names options the pinned agent advertises.
 *
 * A role selection is persisted as free text (`epics.planner_model` and
 * friends) and forwarded to ACP verbatim, so an agent bump that renames or
 * drops an id leaves rows that provision straight into
 * `requested_model_unsupported`. The picker lists are the vocabulary the
 * agent accepts, so a selection outside them is one no dispatch can honour.
 *
 * Matching goes through `matchAdvertisedModel`, the same transform the ACP
 * resolver uses, so this answers exactly what provisioning will answer — a
 * row holding `opus[1m]` or a retired id counts as current precisely when the
 * resolver would land it on something.
 */
export function isCurrentRuntimeSelection(
  selection: RuntimeModelSelection,
): boolean {
  const offersModel =
    matchAdvertisedModel(selection.model, RUNTIME_MODELS[selection.runtime]) !== null;
  const effort = selection.effort;
  const offersEffort =
    effort === undefined ||
    effort === null ||
    RUNTIME_EFFORTS[selection.runtime].some((option) => option.value === effort);
  return offersModel && offersEffort;
}

/** Minimal shape `isAllowedModelForRuntime` needs from a runtime descriptor
 * lookup — narrower than the old AgentRuntime contract, since it needs
 * nothing beyond the descriptor and an optional adapter-native validator. */
export interface RuntimeDescriptorLookup {
  descriptor: RuntimeDescriptor;
  isAllowedModel?(model: string): boolean;
}

export function isAllowedModelForRuntime(
  runtime: RuntimeDescriptorLookup | undefined,
  model: string,
): boolean {
  const trimmedModel = model.trim();
  if (runtime?.isAllowedModel) return runtime.isAllowedModel(trimmedModel);
  const declaredModels = runtime?.descriptor.models ?? [];
  if (declaredModels.length > 0) {
    return declaredModels.some((m) => m.value === trimmedModel);
  }
  return trimmedModel.length > 0;
}
