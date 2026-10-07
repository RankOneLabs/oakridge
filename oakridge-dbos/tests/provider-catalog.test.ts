import { describe, expect, test } from "bun:test";
import { INPUT_CONTRACTS, PROVIDER_CATALOG, PROVIDER_ERROR_CODES, PROVIDER_KINDS } from "../src/effects/provider-catalog";
import { visibleProviderCode } from "../src/effects/operations/production-provider";
import { resolve } from "node:path";

describe("provider declarations", () => {
  test("the provider catalog owns every shipped routing pair", () => {
    expect(PROVIDER_CATALOG.providers).toEqual([
      { kind: PROVIDER_KINDS.repository, input_contract: INPUT_CONTRACTS.repository },
      { kind: PROVIDER_KINDS.session, input_contract: INPUT_CONTRACTS.session },
      { kind: PROVIDER_KINDS.pull_request, input_contract: INPUT_CONTRACTS.pull_request },
      { kind: PROVIDER_KINDS.stub, input_contract: INPUT_CONTRACTS.stub },
    ]);
  });

  test("the catalog declares emitted codes independently of bundle facts", () => {
    expect(PROVIDER_CATALOG.operations.find((operation) => operation.provider_kind === PROVIDER_KINDS.repository)?.emitted_codes)
      .toContain(PROVIDER_ERROR_CODES.head_changed);
  });

  test("an undeclared provider code is a visible rejected outcome naming the original code", () => {
    expect(visibleProviderCode("repository.prepare", 1, "unexpected_failure", "details"))
      .toMatchObject({ kind: "permanently_rejected", code: PROVIDER_ERROR_CODES.undeclared_provider_code,
        detail: expect.stringContaining("unexpected_failure") });
  });

  test("the checked-in workflow-config data matches the provider-owned catalog", async () => {
    const snapshot = await Bun.file(resolve(import.meta.dir, "../../workflow-config/provider-catalog.json")).json();
    expect(snapshot).toEqual({ operations: PROVIDER_CATALOG.operations.filter((operation) => operation.provider_kind !== PROVIDER_KINDS.stub),
      providers: PROVIDER_CATALOG.providers });
  });
});
