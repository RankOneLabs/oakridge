import { expect, test } from "bun:test";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";
import { HTTP_ROUTES, matchRoute } from "../src/http/routes";

const root = resolve(import.meta.dir, "../..");
const pwaPath = resolve(root, "kbbl/core/pwa/oakridge");

interface ClientRoute { readonly method: string; readonly path: string }
interface SourceRoute extends ClientRoute { readonly source: string }
function sourceFiles(directory: string): readonly string[] {
  return readdirSync(directory).flatMap((name) => {
    const path = resolve(directory, name);
    if (statSync(path).isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [path] : [];
  });
}
function routeLiteral(node: ts.Node): string | null {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text;
  if (ts.isTemplateExpression(node)) {
    if (node.head.text.startsWith("/"))
      return node.head.text + node.templateSpans.map((span) => `:value${span.literal.text}`).join("");
    const [prefix, ...spans] = node.templateSpans;
    if (prefix && ts.isIdentifier(prefix.expression) && prefix.expression.text === "API"
      && prefix.literal.text.startsWith("/"))
      return "/oakridge/api" + prefix.literal.text + spans.map((span) => `:value${span.literal.text}`).join("");
    return null;
  }
  return null;
}
function sourceRoutes(path: string, content: string): readonly SourceRoute[] {
  const source = ts.createSourceFile(path, content, ts.ScriptTarget.Latest, true);
  const routes: SourceRoute[] = [];
  function visit(node: ts.Node): void {
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression)) {
      const name = node.expression.text;
      if (["get", "post", "put", "patch", "delete", "fetch_page", "fetch", "request",
        "oakridgeGet", "oakridgePost", "oakridgePatch", "oakridgeDelete"].includes(name)) {
        const isRequest = name === "request";
        const options = node.arguments[1];
        const methodProperty = options && ts.isObjectLiteralExpression(options)
          ? options.properties.find((property) => ts.isPropertyAssignment(property)
            && (ts.isIdentifier(property.name) || ts.isStringLiteral(property.name)) && property.name.text === "method") : undefined;
        const method = isRequest && node.arguments[0] && ts.isStringLiteral(node.arguments[0])
          ? node.arguments[0].text
          : methodProperty && ts.isPropertyAssignment(methodProperty) && ts.isStringLiteral(methodProperty.initializer)
            ? methodProperty.initializer.text : ["get", "post", "put", "patch", "delete"].includes(name) ? name.toUpperCase()
              : name.startsWith("oakridge") ? name.slice("oakridge".length).toUpperCase() : "GET";
        function paths(argument: ts.Node): void {
          const literal = routeLiteral(argument);
          if (literal !== null) {
            // kbbl owns configuration and the run-activity compatibility proxy.
            if (literal === "/oakridge/config" || literal.startsWith("/oakridge/api/run_events?")) return;
            const normalized = literal.replace(/^\/oakridge\/api(?=\/)/, "").split("?")[0];
            if (normalized?.startsWith("/")) routes.push({ method, path: normalized, source: path });
            return;
          }
          ts.forEachChild(argument, paths);
        }
        const argument = node.arguments[isRequest ? 1 : 0];
        if (argument) paths(argument);
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return routes;
}
function clientRoutes(): readonly SourceRoute[] {
  return sourceFiles(pwaPath).flatMap((path) => sourceRoutes(path, readFileSync(path, "utf8")));
}

test("restored v1 PWA uses the v2 run, inbox, review, and definition routes", () => {
  expect(clientRoutes().filter(({ method, path }) => !matchRoute(method, path))).toEqual([]);
  const client = readFileSync(resolve(pwaPath, "client.ts"), "utf8");
  expect(client).toContain('`${OPERATOR}/runs?${query}`');
  expect(client).toContain('`${OPERATOR}/run-inboxes?ids=${ids.map(encodeURIComponent).join(",")}`');
  expect(client).toContain('`${unitPath(runId, unitId)}/reviews/${encodeURIComponent(review)}/decide`');
  expect(client).toContain('`${OPERATOR}/definitions?${query}`');
  for (const route of [
    ["GET", "/api/runs"], ["GET", "/api/run-inboxes"],
    ["POST", "/api/runs/:run_id/units/:unit_id/reviews/:review/decide"],
    ["GET", "/api/definitions"],
  ] as const) expect(matchRoute(route[0], route[1].replaceAll(/:[^/]+/g, "example"))).toBeDefined();
});

test("route guard detects dead routes in helpers, pagination and direct fetches", () => {
  const routes = sourceRoutes("helper.ts", `
    get("/missing-get");
    post(\`/missing-post/\${id}\`, {});
    fetch_page(cursor === null ? "/api/runs" : \`/api/runs?cursor=\${cursor}\`);
    fetch("/oakridge/api/missing-fetch");
    fetch("/oakridge/api/health");
    request("DELETE", "/missing-delete");
  `);
  expect(routes.filter(({ method, path }) => !matchRoute(method, path)).map((route) => route.path))
    .toEqual(["/missing-get", "/missing-post/:value", "/missing-fetch", "/missing-delete"]);
});

test("operator listing, pinning and digest launch have explicit authority", () => {
  const required: readonly ClientRoute[] = [
    { method: "GET", path: "/api/runs" }, { method: "GET", path: "/api/definitions" },
    { method: "POST", path: "/api/definitions" }, { method: "POST", path: "/api/runs" },
  ];
  expect(required.map(({ method, path }) => HTTP_ROUTES.find((row) => row.method === method && row.path === path)?.authority))
    .toEqual(["operator", "operator", "operator", "operator"]);
});
