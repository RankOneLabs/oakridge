import { describe, expect, test } from "bun:test";

import { modelDisplay } from "./modelSelectors";

describe("modelDisplay", () => {
  test("maps claude-sonnet-4-6 to Claude Sonnet 4.6 / Anthropic", () => {
    expect(modelDisplay("claude-sonnet-4-6")).toEqual({
      id: "claude-sonnet-4-6",
      name: "Claude Sonnet 4.6",
      provider: "Anthropic",
    });
  });

  test("maps claude-sonnet-4-5 to Claude Sonnet 4.5 / Anthropic", () => {
    expect(modelDisplay("claude-sonnet-4-5")).toEqual({
      id: "claude-sonnet-4-5",
      name: "Claude Sonnet 4.5",
      provider: "Anthropic",
    });
  });

  test("maps claude-opus-4-7 to Claude Opus 4.7 / Anthropic", () => {
    expect(modelDisplay("claude-opus-4-7")).toEqual({
      id: "claude-opus-4-7",
      name: "Claude Opus 4.7",
      provider: "Anthropic",
    });
  });

  test("maps claude-haiku-4-5 to Claude Haiku 4.5 / Anthropic", () => {
    expect(modelDisplay("claude-haiku-4-5")).toEqual({
      id: "claude-haiku-4-5",
      name: "Claude Haiku 4.5",
      provider: "Anthropic",
    });
  });

  test("maps gpt-5 to GPT-5 / OpenAI", () => {
    expect(modelDisplay("gpt-5")).toEqual({
      id: "gpt-5",
      name: "GPT-5",
      provider: "OpenAI",
    });
  });

  test("maps gpt-5-mini to GPT-5 mini / OpenAI", () => {
    expect(modelDisplay("gpt-5-mini")).toEqual({
      id: "gpt-5-mini",
      name: "GPT-5 mini",
      provider: "OpenAI",
    });
  });

  test("maps gemini-2.5-pro to Gemini 2.5 Pro / Google", () => {
    expect(modelDisplay("gemini-2.5-pro")).toEqual({
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      provider: "Google",
    });
  });

  test("maps gemini-2.5-flash to Gemini 2.5 Flash / Google", () => {
    expect(modelDisplay("gemini-2.5-flash")).toEqual({
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      provider: "Google",
    });
  });

  test("falls back to raw id for unknown model", () => {
    const result = modelDisplay("some-future-model-9");
    expect(result.id).toBe("some-future-model-9");
    expect(result.name).toBe("some-future-model-9");
    expect(typeof result.name).toBe("string");
    expect(result.provider).toBe("Other");
  });

  test("infers Anthropic provider for unmapped claude- prefix", () => {
    const result = modelDisplay("claude-future-1");
    expect(result.id).toBe("claude-future-1");
    expect(result.provider).toBe("Anthropic");
  });

  test("openrouter slug yields OpenRouter provider with humanized name", () => {
    const result = modelDisplay("openrouter/anthropic/claude-3.5-sonnet");
    expect(result.id).toBe("openrouter/anthropic/claude-3.5-sonnet");
    expect(result.provider).toBe("OpenRouter");
    expect(typeof result.name).toBe("string");
    expect(result.name).not.toContain("{");
    expect(result.name).toBe("Claude 3.5 Sonnet");
  });
});
