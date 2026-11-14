import { readdirSync, readFileSync } from "node:fs";
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
interface ColorHsl {
  readonly hue: number;
  readonly saturation: number;
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

function colorHsl(color: string): ColorHsl {
  const [red = 0, green = 0, blue = 0] = [1, 3, 5].map((offset) => Number.parseInt(color.slice(offset, offset + 2), 16) / 255);
  const maximum = Math.max(red, green, blue);
  const minimum = Math.min(red, green, blue);
  const range = maximum - minimum;
  if (range === 0) return { hue: 0, saturation: 0 };
  const sector = maximum === red ? (green - blue) / range
    : maximum === green ? (blue - red) / range + 2 : (red - green) / range + 4;
  return { hue: (sector * 60 + 360) % 360, saturation: range / (1 - Math.abs(maximum + minimum - 1)) };
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
  ...["accent-primary", "accent-name", "accent-secondary", "success-fg"].flatMap((foreground) => SURFACES.map((background) => textPair(foreground, background))),
  textPair("accent-primary", "accent-muted"),
  textPair("accent-contrast-fg", "accent-primary"),
  textPair("input-send-disabled-fg", "input-send-disabled-bg"),
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
  ...["border-subtle", "border-muted", "border-hover", "accent-primary", "amber-border", "permission-border", "danger-card-border"]
    .flatMap((foreground) => SURFACES.map((background) => borderPair(foreground, background))),
  ...TONES.flatMap((tone) => [
    textPair(`badge-${tone}-fg`, `badge-${tone}-bg`),
    ...["bg-app", "bg-surface", "bg-elevated"].map((background) => borderPair(`badge-${tone}-border`, background)),
  ]),
  borderPair("amber-border", "amber-bg"),
  borderPair("permission-border", "permission-bg"),
  borderPair("danger-card-border", "danger-card-bg"),
];

for (const theme of ["dark", "light"] as const) {
  describe(`${theme} theme WCAG AA`, () => {
    const tokens = readTokens(theme);
    it("disabled input Send uses a readable neutral pair distinct from enabled", () => {
      const rule = /\.input-bar-row > button:disabled\s*\{([^}]+)\}/.exec(stylesheet)?.[1] ?? "";
      const foreground = /(?:^|;)\s*color:\s*var\(--([\w-]+)\)/.exec(rule)?.[1] ?? "";
      const background = /(?:^|;)\s*background:\s*var\(--([\w-]+)\)/.exec(rule)?.[1] ?? "";
      expect(foreground).toBe("input-send-disabled-fg");
      expect(background).toBe("input-send-disabled-bg");
      for (const name of [foreground, background]) {
        expect(readBlock(theme).get(`--${name}`)).toMatch(/^#[\da-f]{6}$/i);
      }
      const fg = resolveColor(tokens, foreground);
      const bg = resolveColor(tokens, background);
      const accent = resolveColor(tokens, "accent-primary");
      expect(contrast(fg, bg)).toBeGreaterThanOrEqual(4.5);
      expect(bg).not.toBe(accent);
      expect(colorHsl(bg).saturation).toBeLessThan(colorHsl(accent).saturation);
      expect(fg).not.toBe(resolveColor(tokens, "accent-contrast-fg"));
    });
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


// Source declarations include component-local run accents and measured layout
// properties assigned by hooks.
function readPwaSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    if (["node_modules", "dist"].includes(entry.name)) return [];
    const path = resolve(directory, entry.name);
    if (entry.isDirectory()) return readPwaSources(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\./.test(entry.name)
      ? [readFileSync(path, "utf8")] : [];
  });
}

describe("theme token contract", () => {
  const dark = readTokens("dark");
  const light = readTokens("light");

  it("inherits the exact shared badge palette and elevation in both themes", () => {
    const palette: readonly (readonly [string, string, string, string])[] = [
      ["success", "#173E34", "#9AE3B4", "#398366"],
      ["warning", "#4A371E", "#F3CE8E", "#A57B42"],
      ["danger", "#472930", "#F2AFB9", "#A86476"],
      ["info", "#213C4A", "#A8DCEB", "#568BA3"],
      ["muted", "#343E42", "#DCE3E5", "#7C9299"],
    ];
    for (const [tone, bg, fg, border] of palette) {
      for (const [role, value] of [["bg", bg], ["fg", fg], ["border", border]]) {
        expect(dark.get(`--badge-${tone}-${role}`)).toBe(value);
        expect(light.get(`--badge-${tone}-${role}`)).toBe(value);
      }
    }
    expect(dark.get("--badge-elevation")).toBeTruthy();
    expect(light.get("--badge-elevation")).toBe(dark.get("--badge-elevation"));
    expect([...stylesheet.matchAll(/--badge-elevation\s*:/g)]).toHaveLength(1);
  });

  it("never overrides badge properties in a theme selector", () => {
    for (const rule of stylesheet.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
      if (/\[data-theme[^\]]*\]/.test(rule[1] ?? "")) {
        expect(rule[2]).not.toMatch(/--badge-[\w-]+\s*:/);
      }
    }
  });

  it("resolves every stylesheet and component variable reference to a declaration", () => {
    const sources = readPwaSources(resolve(__dirname, ".."));
    const declarations = [stylesheet, ...sources].join("\n");
    const declared = new Set([
      ...[...declarations.matchAll(/(--[\w-]+)\s*:/g)].map((match) => match[1]),
      ...[...declarations.matchAll(/setProperty\("(--[\w-]+)"/g)].map((match) => match[1]),
    ]);
    for (const source of [stylesheet.replace(/\/\*[\s\S]*?\*\//g, ""), ...sources]) {
      for (const match of source.matchAll(/var\((--[\w-]+)\s*([,)])/g)) {
        expect(declared.has(match[1]), match[1]).toBe(true);
      }
    }
    for (const name of ["accent-primary", "accent-secondary", "border-decorative",
      ...TONES.flatMap((tone) => ["fg", "bg", "border"].flatMap((role) =>
        [`tone-${tone}-${role}`, `badge-${tone}-${role}`]))]) {
      expect(dark.has(`--${name}`) && light.has(`--${name}`), name).toBe(true);
    }
  });
});
