import YAML, { type Node, type YAMLMap } from "yaml";

type Result<Value, Error> = { readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Error };
export interface IncludeError {
  readonly operation: "expand_include";
  readonly entity_id: string;
  readonly detail: string;
}

const includeError = (path: string, detail: string): Result<never, IncludeError> =>
  ({ ok: false, error: { operation: "expand_include", entity_id: path, detail } });

interface IncludeContext {
  readonly workflow: string;
  readonly include: string;
}

function mergeMappings(own: YAMLMap, included: YAMLMap, context: IncludeContext, parent: readonly string[]): Result<YAMLMap, IncludeError> {
  const result = own.clone() as YAMLMap;
  const ownByKey = new Map(result.items.map((pair) => [String(pair.key), pair]));
  const includedOnly = [];
  for (const pair of included.items) {
    const key = String(pair.key);
    const existing = ownByKey.get(key);
    if (!existing) {
      includedOnly.push(pair);
      continue;
    }
    const path = [...parent, key];
    if (!YAML.isMap(existing.value) || !YAML.isMap(pair.value)) {
      return includeError(context.include, `${path.join(".")} is declared in both ${context.workflow} and ${context.include}`);
    }
    const merged = mergeMappings(existing.value, pair.value, context, path);
    if (!merged.ok) return merged;
    existing.value = merged.value;
  }
  result.items.unshift(...includedOnly);
  return { ok: true, value: result };
}

function localizeAnchors(document: YAML.Document, path: string): Result<YAML.Document, IncludeError> {
  const copy = document.clone();
  // Check alias validity and the YAML alias expansion limit at the file boundary.
  try {
    document.toJS();
    const targets = new Map<string, Node>();
    YAML.visit(document, {
      Alias(_, alias) {
        const target = alias.resolve(document);
        if (!target) throw new Error(`Unresolved alias *${alias.source}`);
        targets.set(String(alias.range), target);
      },
    });
    let remainingAliases = 10_000;
    YAML.visit(copy, {
      Alias(_, alias) {
        const target = targets.get(String(alias.range));
        if (!target || --remainingAliases < 0) throw new Error("Invalid or excessively nested aliases");
        return target.clone() as Node;
      },
      Node(_, node) {
        if (node.anchor) delete node.anchor;
      },
    });
    return { ok: true, value: copy };
  } catch (error) {
    return includeError(path, String(error));
  }
}

export function expandIncludes(document: YAML.Document, readInclude: (path: string) => YAML.Document): Result<YAML.Document, IncludeError> {
  const workflow = String(document.get("workflow") ?? "workflow");
  if (!document.has("include")) return { ok: true, value: document.clone() };
  const paths = document.get("include");
  if (!YAML.isSeq(paths) || !paths.items.every((item) => YAML.isScalar(item) && typeof item.value === "string")) {
    return includeError(workflow, "include must be a list of paths");
  }
  const authored = localizeAnchors(document, workflow);
  if (!authored.ok) return authored;
  const result = authored.value;
  result.delete("include");
  // Applying includes right to left keeps their declared ordering.
  for (const item of [...paths.items].reverse()) {
    const path = String(item);
    let included: YAML.Document;
    try {
      included = readInclude(path);
    } catch (error) {
      return includeError(path, String(error));
    }
    if (included.errors.length) return includeError(path, included.errors.map((error) => error.message).join("\n"));
    if (!YAML.isMap(included.contents)) return includeError(path, "include must contain a mapping");
    if (included.has("include")) return includeError(path, "includes may not include other files");
    const localized = localizeAnchors(included, path);
    if (!localized.ok) return localized;
    if (!YAML.isMap(result.contents) || !YAML.isMap(localized.value.contents)) {
      return includeError(path, "workflow and include must contain mappings");
    }
    const merged = mergeMappings(result.contents, localized.value.contents, { workflow, include: path }, []);
    if (!merged.ok) return merged;
    result.contents = merged.value as YAMLMap<unknown, Node>;
  }
  return { ok: true, value: result };
}
