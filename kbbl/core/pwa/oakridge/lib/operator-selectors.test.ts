import { expect, test } from "vitest";
import { selectRootScopeId } from "./operator-selectors";

const scope = (scope_id: string, scope_key: string) => ({ scope_id, scope_key });

test("the root scope is found by its key wherever the server happened to order it", () => {
  const scopes = [scope("0aa", "child"), scope("0bb", "root"), scope("0cc", "child")];
  expect(selectRootScopeId({ scopes, root_key: "root" })).toBe("0bb");
});

test("no root scope is chosen when the run has none with the definition's root key", () => {
  expect(selectRootScopeId({ scopes: [scope("0aa", "child")], root_key: "root" })).toBeNull();
});
