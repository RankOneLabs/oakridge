import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

// Mirrors the literal custom properties and var() aliases in styles.css.
type ThemeName = "dark" | "light";
type ThemeTokens = ReadonlyMap<string, string>;
interface ContrastPair {
  readonly foreground: string;
  readonly background: string;
  readonly minimum: number;
}

const stylesheet = readFileSync(resolve(__dirname, "../styles.css"), "utf8");
const SURFACES = ["bg-app", "bg-surface", "bg-elevated", "bg-code", "bg-input-bar", "bg-input-bar-desktop"];
const TEXT_TIERS = ["text-primary", "text-secondary", "text-tertiary", "text-muted", "text-session", "text-faint", "text-fainter", "text-faintest"];
const TONES = ["info", "success", "warning", "danger", "muted"];
const LEGACY_FAMILIES = ["status-connecting", "status-connected", "status-disconnected", "status-stale", "amber", "permission", "danger"];

function readBlock(theme: ThemeName): ThemeTokens {
  const pattern = theme === "dark" ? /:root\s*\{([^}]+)\}/g : /\[data-theme="light"\]\s*\{([^}]+)\}/g;
  const blocks = [...stylesheet.matchAll(pattern)];
  expect(blocks, `${theme} has exactly one token block`).toHaveLength(1);
  const declarations = [...(blocks[0]?.[1] ?? "").matchAll(/(--[\w-]+):\s*([^;]+);/g)];
  const tokens = new Map(declarations.map((declaration) => [declaration[1] ?? "", declaration[2]?.trim() ?? ""]));
  expect(tokens.size, `${theme} has no duplicate tokens`).toBe(declarations.length);
  return tokens;
}

function readTokens(theme: ThemeName): ThemeTokens {
  const root = readBlock("dark");
  return theme === "dark" ? root : new Map([...root, ...readBlock("light")]);
}

function resolveColor(tokens: ThemeTokens, name: string): string {
  let value = tokens.get(`--${name}`) ?? "";
  const visited = new Set<string>();
  while (value.startsWith("var(")) {
    expect(visited.has(value), `cyclic alias: ${name}`).toBe(false);
    visited.add(value);
    const alias = /^var\((--[\w-]+)\)$/.exec(value)?.[1] ?? "";
    value = tokens.get(alias) ?? "";
  }
  expect(value, `literal color for ${name}`).toMatch(/^#[\da-f]{6}$/i);
  return value;
}

function luminance(color: string): number {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) => {
    const channel = Number.parseInt(color.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
}

function contrast(first: string, second: string): number {
  const values = [luminance(first), luminance(second)];
  return (Math.max(...values) + 0.05) / (Math.min(...values) + 0.05);
}

function textPair(foreground: string, background: string): ContrastPair {
  return { foreground, background, minimum: 4.5 };
}

function borderPair(foreground: string, background: string): ContrastPair {
  return { foreground, background, minimum: 3 };
}

// Explicitly cover text, semantic fills, primary/inverse button labels, and
// control/focus indicators. Decorative shadows are not boundary indicators.
const PAIRS: readonly ContrastPair[] = [
  ...TEXT_TIERS.flatMap((foreground) => [...SURFACES, "accent-muted", ...TONES.map((tone) => `tone-${tone}-bg`)]
    .map((background) => textPair(foreground, background))),
  ...["accent-blue", "accent-name", "accent-secondary", "success-fg"].flatMap((foreground) => SURFACES.map((background) => textPair(foreground, background))),
  textPair("accent-blue", "accent-muted"),
  textPair("accent-contrast-fg", "accent-blue"),
  textPair("bubble-user-fg", "bubble-user-bg"),
  textPair("bubble-assistant-fg", "bubble-assistant-bg"),
  textPair("text-secondary", "tone-muted-bg"),
  textPair("danger-fg", "danger-card-bg"),
  textPair("bg-app", "tone-danger-fg"),
  ...TONES.flatMap((tone) => [
    ...[...SURFACES, `tone-${tone}-bg`].map((background) => textPair(`tone-${tone}-fg`, background)),
    ...["bg-surface", "bg-elevated", `tone-${tone}-bg`].map((background) => borderPair(`tone-${tone}-border`, background)),
  ]),
  ...LEGACY_FAMILIES.flatMap((family) => [...SURFACES, `${family}-bg`].map((background) => textPair(`${family}-fg`, background))),
  ...["border-subtle", "border-muted", "border-hover", "accent-blue", "amber-border", "permission-border", "danger-card-border"]
    .flatMap((foreground) => SURFACES.map((background) => borderPair(foreground, background))),
  borderPair("amber-border", "amber-bg"),
  borderPair("permission-border", "permission-bg"),
  borderPair("danger-card-border", "danger-card-bg"),
];

for (const theme of ["dark", "light"] as const) {
  describe(`${theme} theme WCAG AA`, () => {
    const tokens = readTokens(theme);
    it("skill-group count text meets 4.5:1 on its declared background", () => {
      const rule = /\.skill-rail__group-count\s*\{([^}]+)\}/.exec(stylesheet)?.[1] ?? "";
      const foreground = /(?:^|;)\s*color:\s*var\(--([\w-]+)\)/.exec(rule)?.[1] ?? "";
      const background = /(?:^|;)\s*background:\s*var\(--([\w-]+)\)/.exec(rule)?.[1] ?? "";
      expect(contrast(resolveColor(tokens, foreground), resolveColor(tokens, background))).toBeGreaterThanOrEqual(4.5);
    });
    for (const { foreground, background, minimum } of PAIRS) {
      it(`${foreground} on ${background} meets ${minimum}:1`, () => {
        expect(contrast(resolveColor(tokens, foreground), resolveColor(tokens, background))).toBeGreaterThanOrEqual(minimum);
      });
    }
    for (const tone of TONES) {
      for (const role of ["fg", "bg", "border"]) {
        it(`tone-${tone}-${role} is a literal per-theme color`, () => {
          expect(tokens.get(`--tone-${tone}-${role}`)).toMatch(/^#[\da-f]{6}$/i);
        });
      }
    }
    if (theme === "dark") {
      it("steps app < surface < elevated luminance", () => {
        const app = luminance(resolveColor(tokens, "bg-app"));
        const surface = luminance(resolveColor(tokens, "bg-surface"));
        const elevated = luminance(resolveColor(tokens, "bg-elevated"));
        expect(app).toBeLessThan(surface);
        expect(surface).toBeLessThan(elevated);
      });
    }
  });
}
