import { ARTIFACT_KEYS } from "../artifact-versions";
import { ok } from "../../../domain/primitives";
import { definition, pathItem, register, topList, type Registration } from "../extractor-helpers";

const { drafting, outlining } = ARTIFACT_KEYS.portability;
export const registrations: readonly Registration[] = [
  register(outlining.roadmap, [
    definition("portability.folio", "folio", "/folios/*", topList("folios", (body, path) =>
      ok(pathItem("folio", "/folios/*", path, body)))),
  ]),
  register(drafting.appraisal, [
    definition("portability.remark", "remark", "/remarks/*", topList("remarks", (body, path) =>
      ok(pathItem("remark", "/remarks/*", path, body)))),
  ]),
];
