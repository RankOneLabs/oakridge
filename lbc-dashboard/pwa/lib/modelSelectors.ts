export interface ModelDisplay {
  id: string;
  name: string;
  provider: "Anthropic" | "OpenAI" | "Google" | "OpenRouter" | "Other";
}

type Provider = ModelDisplay["provider"];

const KNOWN: Record<string, { name: string; provider: Provider }> = {
  "claude-sonnet-4-6": { name: "Claude Sonnet 4.6", provider: "Anthropic" },
  "claude-sonnet-4-5": { name: "Claude Sonnet 4.5", provider: "Anthropic" },
  "claude-opus-4-7": { name: "Claude Opus 4.7", provider: "Anthropic" },
  "claude-haiku-4-5": { name: "Claude Haiku 4.5", provider: "Anthropic" },
  "gpt-5": { name: "GPT-5", provider: "OpenAI" },
  "gpt-5-mini": { name: "GPT-5 mini", provider: "OpenAI" },
  "gemini-2.5-pro": { name: "Gemini 2.5 Pro", provider: "Google" },
  "gemini-2.5-flash": { name: "Gemini 2.5 Flash", provider: "Google" },
};

function inferProvider(id: string): Provider {
  if (id.startsWith("claude")) return "Anthropic";
  if (
    id.startsWith("gpt") ||
    id.startsWith("o1") ||
    id.startsWith("o3")
  )
    return "OpenAI";
  if (id.startsWith("gemini")) return "Google";
  if (id.startsWith("openrouter/")) return "OpenRouter";
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

export function modelDisplay(id: string): ModelDisplay {
  const known = KNOWN[id];
  if (known !== undefined) {
    return { id, ...known };
  }
  const provider = inferProvider(id);
  if (provider === "OpenRouter") {
    return { id, name: humanizeOpenRouterSlug(id), provider };
  }
  return { id, name: id, provider };
}
