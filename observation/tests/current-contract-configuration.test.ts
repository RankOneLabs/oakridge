import { expect, test } from "bun:test";
import { configurationDocumentSchema, parseGradingDefinitions, planRegistration } from "../src/grading/configuration";
import { oakridgeGradingRegistry } from "../src/producers/oakridge/profile";
import { gradingSubjects } from "../src/grading/evidence";
import type { ItemOccurrenceId, LogicalItemId } from "../src/domain/identity";
import { fixtureBody } from "./grading-fixture";

const document = await Bun.file(new URL("./fixtures/grading-definitions-current.json", import.meta.url)).json();
test("current configuration document parses and every target and capability registers", () => {
  expect(configurationDocumentSchema.safeParse(document).success).toBe(true);
  const definitions = parseGradingDefinitions(document.definitions, oakridgeGradingRegistry);
  expect(definitions.ok).toBe(true);
  if (!definitions.ok) throw new Error(JSON.stringify(definitions.error));
  const registration = planRegistration(definitions.value, oakridgeGradingRegistry);
  expect(registration.ok).toBe(true);
  if (!registration.ok) throw new Error(JSON.stringify(registration.error));
});
test("per_task build items use only structurally declared requirement_ids", async () => {
  const body = await fixtureBody("current-brief") as { build_items: readonly import("../src/domain/primitives").JsonValue[] };
  const subject = "build-item" as ItemOccurrenceId;
  expect(gradingSubjects({ occurrence: { occurrence_id: subject, json_pointer: "/build_items/0", selected_value: body.build_items[0]! },
    scope: { scope: "per_task", task_ids: "/requirement_ids" }, relations: ["R1", "R3"].map((id, index) => ({
      source_occurrence_id: subject, target_occurrence_id: null, target_logical_item_id: id as LogicalItemId,
      unresolved_target_ref: null, type: "addresses", evidence_ref: `/build_items/0/requirement_ids/${index}`,
    })) }).map((subject) => String(subject.task_id))).toEqual(["R1", "R3"]);
});
