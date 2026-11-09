/**
 * Generates kbbl/core/pwa/oakridge/operator-contracts/ from the operator API
 * the backend declares in oakridge-dbos/src/http/operator-api.ts.
 *
 * Every type the API references is copied from its one backend declaration
 * (projections, storage rows, generated core contracts) with every name
 * prefixed `Operator`. Branded ids become `string` and `Date` becomes
 * `string`, which is what both serialize to. See contract-generator.ts.
 *
 * Each declaration lands in the file mirroring its backend module, so
 * projections/unit-view.ts generates operator-contracts/projections/unit-view.ts.
 */
import { resolve } from "node:path";
import { writeContracts } from "./contract-generator";

const root = resolve(import.meta.dir, "../..");
writeContracts({
  name: "generate-operator-contracts",
  root,
  api: resolve(root, "oakridge-dbos/src/http/operator-api.ts"),
  backend: resolve(root, "oakridge-dbos/src"),
  output: resolve(root, "kbbl/core/pwa/oakridge/operator-contracts"),
  prefix: "Operator",
  brands: { kind: "erase", primitives: resolve(root, "oakridge-dbos/src/domain/primitives.ts") },
  header: "// Generated from oakridge-dbos/src/http/operator-api.ts. Run bun kbbl/scripts/generate-operator-contracts.ts.\n"
    + "// The PWA intentionally imports no backend source at runtime or typecheck time.\n\n",
}, process.argv);
