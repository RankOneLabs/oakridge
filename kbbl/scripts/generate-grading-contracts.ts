/**
 * Generates kbbl/core/pwa/oakridge/grading-contracts/ from the grading API
 * observation declares in observation/src/http/grading-api.ts, including the
 * configuration document, catalogue, publication, runtime and historical evaluator reads.
 *
 * Every type the API references is copied from its one observation declaration
 * with every name prefixed `Observation`. Branded ids keep their brands, so the
 * PWA cannot mix an occurrence id with a revision id; `Date` becomes `string`.
 * See contract-generator.ts.
 *
 * Each declaration lands in the file mirroring its observation module, so
 * grading/composite.ts generates grading-contracts/grading/composite.ts.
 */
import { resolve } from "node:path";
import { writeContracts } from "./contract-generator";

const root = resolve(import.meta.dir, "../..");
writeContracts({
  name: "generate-grading-contracts",
  root,
  api: resolve(root, "observation/src/http/grading-api.ts"),
  backend: resolve(root, "observation/src"),
  output: resolve(root, "kbbl/core/pwa/oakridge/grading-contracts"),
  prefix: "Observation",
  brands: { kind: "keep" },
  header: "// Generated from observation/src/http/grading-api.ts. Run bun kbbl/scripts/generate-grading-contracts.ts.\n"
    + "// The PWA intentionally imports no backend source at runtime or typecheck time.\n\n",
}, process.argv);
