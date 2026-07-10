// AUTO-GENERATED — do not edit.
// Source: kbbl/core/model-catalog.ts
// Regenerate: bun run lbc-dashboard/scripts/generate_model_catalog.ts
// CI drift: regenerate then `git diff --exit-code lbc-dashboard/src/generated/model_catalog.ts`.

export type ModelProvider = "Anthropic" | "OpenAI" | "Google" | "OpenRouter" | "Other";

export interface ModelMeta {
  id: string;
  label: string;
  provider: ModelProvider;
  /** Lower = earlier in sorted lists and launch-form checkboxes. */
  order: number;
  /** Offer as a quick-pick checkbox in the lbc launch form. */
  inForm: boolean;
}

export const LBC_STUDY_MODEL_CATALOG: readonly ModelMeta[] = [
  { id: "claude-sonnet-4-6",  label: "Claude Sonnet 4.6",  provider: "Anthropic", order: 1, inForm: false },
  { id: "claude-sonnet-4-5",  label: "Claude Sonnet 4.5",  provider: "Anthropic", order: 2, inForm: true  },
  { id: "claude-opus-4-8",    label: "Claude Opus 4.8",    provider: "Anthropic", order: 3, inForm: true  },
  { id: "claude-opus-4-7",    label: "Claude Opus 4.7",    provider: "Anthropic", order: 4, inForm: true  },
  { id: "claude-haiku-4-5",   label: "Claude Haiku 4.5",   provider: "Anthropic", order: 5, inForm: true  },
  { id: "gpt-5.6-sol",        label: "GPT-5.6 Sol",        provider: "OpenAI",    order: 6, inForm: true  },
  { id: "gpt-5.6-terra",      label: "GPT-5.6 Terra",      provider: "OpenAI",    order: 7, inForm: true  },
  { id: "gpt-5.6-luna",       label: "GPT-5.6 Luna",       provider: "OpenAI",    order: 8, inForm: true  },
  { id: "gpt-5.5",            label: "GPT-5.5",            provider: "OpenAI",    order: 9, inForm: true  },
  { id: "gpt-5.4",            label: "GPT-5.4",            provider: "OpenAI",    order: 10, inForm: true  },
  { id: "gpt-5.4-mini",       label: "GPT-5.4 mini",       provider: "OpenAI",    order: 11, inForm: true  },
  { id: "gpt-5.3-codex-spark", label: "GPT-5.3 Codex Spark", provider: "OpenAI", order: 12, inForm: true  },
  { id: "gpt-5",              label: "GPT-5",              provider: "OpenAI",    order: 13, inForm: true  },
  { id: "gpt-5-mini",         label: "GPT-5 mini",         provider: "OpenAI",    order: 14, inForm: true  },
  { id: "gemini-2.5-pro",     label: "Gemini 2.5 Pro",     provider: "Google",    order: 15, inForm: false },
  { id: "gemini-2.5-flash",   label: "Gemini 2.5 Flash",   provider: "Google",    order: 16, inForm: false },
];

const _BY_ID = new Map(LBC_STUDY_MODEL_CATALOG.map((m) => [m.id, m]));

export function modelMetaFor(id: string): ModelMeta | undefined {
  return _BY_ID.get(id);
}

export function modelLabelFromCatalog(id: string): string {
  return _BY_ID.get(id)?.label ?? id;
}
