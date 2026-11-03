import { z } from "zod";
import type { QuestionDefinition } from "../question";

export const EVIDENCE_ROLES = ["requested_change", "relevant_excerpt", "analysis_finding", "plan_task", "plan_decision",
  "plan_criterion", "brief_criterion", "assessment_finding"] as const;
export type EvidenceRole = typeof EVIDENCE_ROLES[number];

/** Where a slot's items come from. `subject` is the graded item itself. `linked` names one
 * relation to walk — outward from the subject's own links, or inward from the items that link
 * back to it. `unscheduled` says no captured artifact in a run supplies this role at all.
 *
 * A slot declares the relation; which revisions are in scope stays with the builder, because
 * capture-time windows are not expressible as a relation and a pin should not pretend otherwise. */
export type SlotSource =
  | { readonly from: "subject" }
  | { readonly from: "linked"; readonly link_type: string; readonly direction: "out" | "in";
    readonly artifact_kind: string; readonly item_kind: string }
  | { readonly from: "unscheduled" };

export interface EvidenceSlot {
  readonly role: EvidenceRole;
  readonly source: SlotSource;
  readonly min_count: number;
  readonly max_count: number;
}

/** The traversal a question's evidence needs, named because slots cannot express it: which
 * revisions are in scope, and how a failure to resolve is classified.
 *
 * `linked_sources` walks the slot relations and classifies two failures the slots cannot name —
 * a subject that declares no link at all, and a source revision the run never captured. Plan
 * traceability and brief fidelity differ only in those two choices. */
export type EvidenceBuild =
  | { readonly kind: "linked_sources"; readonly undeclared: "uncited" | "unlinked";
    readonly uncaptured_source: "incomplete" | "dangling" }
  | { readonly kind: "assessment_window" }
  | { readonly kind: "unscheduled_source"; readonly detail: string };

/** The captured item a decision is recorded against. Replaces matching on the question id. */
export interface SubjectBinding { readonly artifact_kind: string; readonly item_kind: string }

export interface PilotEvidenceRecipe {
  readonly recipe_version: "v1";
  readonly build: EvidenceBuild;
  readonly subject: SubjectBinding;
  readonly input: readonly EvidenceSlot[];
  readonly output: readonly EvidenceSlot[];
}

const subjectSlot = (role: EvidenceRole): EvidenceSlot =>
  ({ role, source: { from: "subject" }, min_count: 1, max_count: 1 });
const linkedSlot = (role: EvidenceRole, source: Omit<Extract<SlotSource, { from: "linked" }>, "from">,
  min_count: number, max_count: number): EvidenceSlot =>
  ({ role, source: { from: "linked", ...source }, min_count, max_count });
const unscheduledSlot = (role: EvidenceRole): EvidenceSlot =>
  ({ role, source: { from: "unscheduled" }, min_count: 1, max_count: 1 });

/** No captured artifact carries the requested change or its excerpt, so this question has no
 * buildable evidence in a run. The pin says so rather than a builder omitting it silently. */
export const ANALYSIS_RELEVANCE_RECIPE: PilotEvidenceRecipe = {
  recipe_version: "v1", subject: { artifact_kind: "analysis", item_kind: "finding" },
  build: { kind: "unscheduled_source", detail: "no relevant excerpt source is scheduled" },
  input: [unscheduledSlot("requested_change"), unscheduledSlot("relevant_excerpt")],
  output: [subjectSlot("analysis_finding")],
};

export const PLAN_TRACEABILITY_RECIPE: PilotEvidenceRecipe = {
  recipe_version: "v1", subject: { artifact_kind: "plan", item_kind: "criterion" },
  build: { kind: "linked_sources", undeclared: "uncited", uncaptured_source: "incomplete" },
  input: [
    linkedSlot("plan_task", { link_type: "derived_from", direction: "out", artifact_kind: "tasks", item_kind: "task" }, 0, 20),
    linkedSlot("plan_decision", { link_type: "derived_from", direction: "out", artifact_kind: "plan", item_kind: "decision" }, 0, 20),
  ],
  output: [subjectSlot("plan_criterion")],
};

export const BRIEF_FIDELITY_RECIPE: PilotEvidenceRecipe = {
  recipe_version: "v1", subject: { artifact_kind: "brief", item_kind: "criterion" },
  build: { kind: "linked_sources", undeclared: "unlinked", uncaptured_source: "dangling" },
  input: [linkedSlot("plan_criterion", { link_type: "derived_from", direction: "out", artifact_kind: "plan", item_kind: "criterion" }, 1, 1)],
  output: [subjectSlot("brief_criterion")],
};

export const ASSESSMENT_COVERAGE_RECIPE: PilotEvidenceRecipe = {
  recipe_version: "v1", subject: { artifact_kind: "brief", item_kind: "criterion" },
  build: { kind: "assessment_window" },
  input: [subjectSlot("brief_criterion")],
  output: [linkedSlot("assessment_finding",
    { link_type: "assesses", direction: "in", artifact_kind: "assessment", item_kind: "assessment_finding" }, 0, 100)],
};

const slotSourceSchema = z.discriminatedUnion("from", [
  z.object({ from: z.literal("subject") }),
  z.object({ from: z.literal("linked"), link_type: z.string().min(1), direction: z.enum(["out", "in"]),
    artifact_kind: z.string().min(1), item_kind: z.string().min(1) }),
  z.object({ from: z.literal("unscheduled") }),
]);

const slotSchema = z.object({ role: z.enum(EVIDENCE_ROLES), source: slotSourceSchema,
  min_count: z.number().int().min(0), max_count: z.number().int().min(1) })
  .refine((slot) => slot.max_count >= slot.min_count, { message: "max_count is below min_count" });

const buildSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("linked_sources"), undeclared: z.enum(["uncited", "unlinked"]),
    uncaptured_source: z.enum(["incomplete", "dangling"]) }),
  z.object({ kind: z.literal("assessment_window") }),
  z.object({ kind: z.literal("unscheduled_source"), detail: z.string().min(1) }),
]);

/** The pin carries the whole recipe — build, subject binding and slot counts — so reading it
 * never needs a table keyed by question id. A question is supported because of what it pins. */
const pinnedRecipeSchema = z.object({ recipe_version: z.literal("v1"), build: buildSchema,
  subject: z.object({ artifact_kind: z.string().min(1), item_kind: z.string().min(1) }),
  input: z.array(slotSchema), output: z.array(slotSchema) });

export function pinnedInputRecipe(recipe: PilotEvidenceRecipe): QuestionDefinition["input_recipe"] {
  const slot = (entry: EvidenceSlot) => ({ role: entry.role, source: { ...entry.source },
    min_count: entry.min_count, max_count: entry.max_count });
  return { recipe_version: recipe.recipe_version, build: { ...recipe.build }, subject: { ...recipe.subject },
    input: recipe.input.map(slot), output: recipe.output.map(slot) };
}

/** Read the recipe a question pins. Returns null when the pin is not a slot recipe, which is how
 * a judge-recipe or deterministic question reports that this path does not own it. */
export function pinnedPilotRecipe(question: QuestionDefinition): PilotEvidenceRecipe | null {
  const parsed = pinnedRecipeSchema.safeParse(question.input_recipe);
  if (!parsed.success || question.question_version !== parsed.data.recipe_version) return null;
  return parsed.data;
}

export function recipeSlots(recipe: PilotEvidenceRecipe): readonly EvidenceSlot[] {
  return [...recipe.input, ...recipe.output];
}

/** Roles whose reference count falls outside the pinned slot's bounds. The role is the prefix
 * `capturedReference` writes into every ref, so a built package can be checked against the pin
 * that is supposed to govern it. Empty means the package satisfies its recipe. */
export function unsatisfiedSlots(recipe: PilotEvidenceRecipe,
  references: readonly { readonly ref: string }[]): readonly EvidenceRole[] {
  const counts = new Map<string, number>();
  for (const { ref } of references) {
    const separator = ref.indexOf(":");
    if (separator <= 0) continue;
    const role = ref.slice(0, separator);
    counts.set(role, (counts.get(role) ?? 0) + 1);
  }
  return recipeSlots(recipe).filter((slot) => {
    const seen = counts.get(slot.role) ?? 0;
    return seen < slot.min_count || seen > slot.max_count;
  }).map((slot) => slot.role);
}
