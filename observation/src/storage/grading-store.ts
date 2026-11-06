import { sql } from "kysely";
import type { GradeListingItem } from "../grading/observation";
import type { Page } from "./projection-store";
import { withTenant, type Database, type TenantScope } from "./database";
export interface GradePage extends Page { readonly total: number; readonly items: readonly GradeListingItem[] }

export function listGrades(db: Database, tenant: TenantScope, occurrence_id: string, page: Page): Promise<GradePage | null> {
  return withTenant(db, tenant, async (trx) => {
    const item = await trx.selectFrom("observation.item_occurrence").select("occurrence_id")
      .where("producer", "=", tenant.producer).where("namespace", "=", tenant.namespace)
      .where("occurrence_id", "=", occurrence_id).executeTakeFirst();
    if (!item) return null;
    const count = await trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
        .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("x.subject_occurrence_id", "=", occurrence_id).executeTakeFirstOrThrow();
    const rows = await trx.selectFrom("observation.grade_observation as g")
      .innerJoin("observation.evaluation_execution as x", (join) => join.onRef("x.producer", "=", "g.producer")
        .onRef("x.namespace", "=", "g.namespace").onRef("x.execution_id", "=", "g.execution_id"))
      .innerJoin("observation.evaluator_definition as d", (join) => join.onRef("d.producer", "=", "g.producer")
        .onRef("d.namespace", "=", "g.namespace").onRef("d.evaluator_definition_id", "=", "x.evaluator_definition_id"))
      .select([
        sql<GradeListingItem["observation"]>`to_jsonb(g)`.as("observation"),
        sql<GradeListingItem["execution"]>`to_jsonb(x)`.as("execution"),
        sql<GradeListingItem["evaluator"]>`to_jsonb(d)`.as("evaluator"),
      ])
      .where("g.producer", "=", tenant.producer).where("g.namespace", "=", tenant.namespace)
      .where("x.subject_occurrence_id", "=", occurrence_id)
      .orderBy("g.recorded_at", "asc").orderBy("g.observation_id", "asc").limit(page.limit).offset(page.offset).execute();
    const items: GradeListingItem[] = rows.map(({ observation, execution, evaluator }) => ({
      observation,
      answer: observation.answer_payload, evaluator, execution,
    }));
    return { items, total: Number(count.count), ...page };
  });
}
