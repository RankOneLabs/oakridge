import {
  LBC_STUDY_MODEL_CATALOG,
  modelMetaFor,
} from "../../src/generated/model_catalog";
import type { ModelProvider } from "../../src/generated/model_catalog";

export type { ModelProvider };

export interface ModelDisplay {
  id: string;
  name: string;
  provider: ModelProvider;
}

function inferProvider(id: string): ModelProvider {
  if (id.startsWith("claude")) return "Anthropic";
  if (id.startsWith("gpt") || id.startsWith("o1") || id.startsWith("o3"))
    return "OpenAI";
  if (id.startsWith("gemini")) return "Google";
  return "Other";
}

function humanizeOpenRouterSlug(id: string): string {
  const afterPrefix = id.slice("openrouter/".length);
  if (!afterPrefix) return id;
  const lastSlash = afterPrefix.lastIndexOf("/");
  const leaf = lastSlash >= 0 ? afterPrefix.slice(lastSlash + 1) : afterPrefix;
  if (!leaf) return id;
  const spaced = leaf.replace(/[-_]/g, " ");
  return spaced.replace(/\b\w/g, (c) => c.toUpperCase());
}

/**
 * Resolve a model id to its display name and provider.
 *
 * Known models are resolved from the catalog. For unknown ids the name
 * falls back to the raw id and the provider is inferred from the prefix.
 * openrouter/ slugs get a humanized name.
 *
 * Pass a custom catalog slice for tests or local overrides; the default
 * is the full LBC study catalog.
 */
export function modelDisplay(
  id: string,
  catalog: typeof LBC_STUDY_MODEL_CATALOG = LBC_STUDY_MODEL_CATALOG,
): ModelDisplay {
  const entry =
    catalog === LBC_STUDY_MODEL_CATALOG
      ? modelMetaFor(id)
      : catalog.find((m) => m.id === id);
  if (entry !== undefined) {
    return { id, name: entry.label, provider: entry.provider };
  }
  if (id.startsWith("openrouter/")) {
    return { id, name: humanizeOpenRouterSlug(id), provider: "OpenRouter" };
  }
  return { id, name: id, provider: inferProvider(id) };
}
