import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

export interface RustToken { readonly kind: "word" | "string" | "symbol"; readonly text: string }
/** Tokenize comments, raw/escaped strings and multiline imports before inspecting capabilities. */
export function rustTokens(source: string): readonly RustToken[] {
  const tokens: RustToken[] = [];
  let offset = 0;
  while (offset < source.length) {
    const rest = source.slice(offset);
    if (/^\s/.test(rest)) { offset++; continue; }
    if (rest.startsWith("//")) { const end = source.indexOf("\n", offset); offset = end < 0 ? source.length : end + 1; continue; }
    if (rest.startsWith("/*")) {
      let depth = 1; offset += 2;
      while (depth && offset < source.length) {
        if (source.slice(offset, offset + 2) === "/*") { depth++; offset += 2; }
        else if (source.slice(offset, offset + 2) === "*/") { depth--; offset += 2; }
        else offset++;
      }
      if (depth) throw new Error("unterminated Rust comment");
      continue;
    }
    const raw = /^(?:br|r)(#*)"/.exec(rest);
    if (raw) {
      const hashes = raw[1] ?? "";
      const start = offset + raw[0].length;
      const end = source.indexOf(`"${hashes}`, start);
      if (end < 0) throw new Error("unterminated raw Rust string");
      tokens.push({ kind: "string", text: source.slice(start, end) }); offset = end + hashes.length + 1; continue;
    }
    if (rest.startsWith('"')) {
      let end = offset + 1;
      while (end < source.length && source[end] !== '"') { if (source[end] === "\\") end++; end++; }
      if (end === source.length) throw new Error("unterminated Rust string");
      const literal = source.slice(offset + 1, end).replace(/\\\r?\n\s*/g, "");
      tokens.push({ kind: "string", text: literal }); offset = end + 1; continue;
    }
    // Character literals are not lifetimes and may contain punctuation.
    const char = /^'(?:\\.|[^'\\])'/.exec(rest);
    if (char) { offset += char[0].length; continue; }
    const word = /^(?:r#)?[A-Za-z_][A-Za-z_0-9]*/.exec(rest);
    if (word) { tokens.push({ kind: "word", text: word[0].replace(/^r#/, "") }); offset += word[0].length; continue; }
    tokens.push({ kind: "symbol", text: rest[0] ?? "" }); offset++;
  }
  return tokens;
}
type RustDelimiter = "(" | "[" | "{";
/** Find one annotated item's end; unsupported/unbalanced syntax stays visible. */
function rustItemEnd(tokens: readonly RustToken[], start: number): number | null {
  const groups: RustDelimiter[] = [];
  let requiresSemicolon = false;
  let isItemBody = false;
  let genericDepth = 0;
  for (let index = start; index < tokens.length; index++) {
    const token = tokens[index];
    if (!token || token.kind === "string") continue;
    const text = token.text;
    if (groups.length === 0) {
      if (["static", "type", "use"].includes(text)) requiresSemicolon = true;
      if (text === "const" && !["fn", "unsafe", "async"].includes(tokens[index + 1]?.text ?? "")) requiresSemicolon = true;
      if (!requiresSemicolon && text === "<") genericDepth++;
      if (!requiresSemicolon && text === ">" && genericDepth > 0) genericDepth--;
      if (text === ";" && genericDepth === 0) return index + 1;
      if (text === "{" && genericDepth === 0) isItemBody = !requiresSemicolon;
    }
    if (text === "(" || text === "[" || text === "{") groups.push(text);
    if (text === ")" || text === "]" || text === "}") {
      const opening = groups.pop();
      if (!opening || (opening === "(" && text !== ")") || (opening === "[" && text !== "]") || (opening === "{" && text !== "}")) return null;
      if (groups.length === 0 && isItemBody) return index + 1;
    }
  }
  return null;
}
export function productionTokens(source: string): readonly RustToken[] {
  const tokens = rustTokens(source);
  const result: RustToken[] = [];
  for (let index = 0; index < tokens.length; index++) {
    if (tokens.slice(index, index + 7).map((token) => token.text).join("") === "#[cfg(test)]") {
      const end = rustItemEnd(tokens, index + 7);
      if (end !== null) { index = end - 1; continue; }
    }
    const token = tokens[index];
    if (token) result.push(token);
  }
  return result;
}
export function rustLibraryGraph(root: string): readonly string[] {
  const queue = ["model", "compiler", "evaluator"].map((name) => resolve(root, `workflow-core/crates/${name}/src/lib.rs`));
  const seen = new Set<string>();
  while (queue.length) {
    const file = queue.pop();
    if (!file || seen.has(file)) continue;
    seen.add(file);
    const tokens = productionTokens(readFileSync(file, "utf8"));
    if (tokens.some((token, index) => token.text === "path" && tokens[index - 1]?.text === "[")) throw new Error(`unresolved Rust path attribute: ${file}`);
    for (let index = 0; index < tokens.length; index++) {
      if (tokens[index]?.text !== "mod" || tokens[index + 1]?.kind !== "word" || tokens[index + 2]?.text !== ";") continue;
      const name = tokens[index + 1]?.text;
      const directory = /(?:lib|mod)\.rs$/.test(file) ? dirname(file) : file.replace(/\.rs$/, "");
      const module = [resolve(directory, `${name}.rs`), resolve(directory, `${name}/mod.rs`)].find(existsSync);
      if (!module) throw new Error(`unresolved Rust module: ${file} -> ${name}`);
      queue.push(module);
    }
  }
  return [...seen];
}
export function rustCapabilityViolations(source: string): readonly string[] {
  const tokens = productionTokens(source);
  const text = tokens.filter((token) => token.kind !== "string").map((token) => token.text).join(" ");
  const violations: string[] = [];
  if (/\b(HashMap|HashSet|RandomState)\b/.test(text)) violations.push("randomly seeded collection");
  const stdModules = /\bstd\s*:\s*:\s*(fs|net|process|env|time|thread|io)\b/;
  if (stdModules.test(text)) violations.push("external std capability");
  // Grouped imports and aliases expose the capability at their import site.
  if (/\buse\s+std\s*:\s*:\s*\{[^;]*(?:\b(?:fs|net|process|env|time|thread|io)\b|\*)/.test(text)
    || /\buse\s+std\s+(?:as\b|;)/.test(text) || /\buse\s+std\s*:\s*:\s*\*/.test(text)) violations.push("unbounded or IO std import");
  if (/\b(tokio|reqwest|ureq|rand|getrandom|chrono|postgres|sqlx|rusqlite|diesel)\s*:\s*:/.test(text)) violations.push("external crate capability");
  if (/\b(include|include_str|include_bytes|env|option_env)\s*!/.test(text) || /\bextern\b/.test(text)) violations.push("unresolved external code or environment capability");
  return violations;
}
export function workflowLiteralViolations(source: string): readonly string[] {
  const names = new Set(["dev_flow", "dev-flow", "development", "spec", "plan", "brief", "build", "assessment", "final_integration"]);
  // Reject literals anywhere in the library, so a constant outside a multiline
  // branch cannot smuggle a workflow identifier into the interpreter.
  return productionTokens(source).filter((token) => token.kind === "string" && names.has(token.text)).map((token) => token.text);
}
