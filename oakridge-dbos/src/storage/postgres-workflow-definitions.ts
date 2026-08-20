import type { WorkflowDefinitionId } from "../domain/primitives";
import type { WorkflowDefinition } from "../domain/workflow";
import { parseWorkflowDefinition } from "../validation/workflow-definition";
import type { WorkflowDefinitionRepository } from "./repositories";
import type { SqlExecutor } from "./sql-executor";

interface DefinitionRow { readonly definition: unknown }

const decodeDefinition = (row: DefinitionRow): WorkflowDefinition => {
  const parsed = parseWorkflowDefinition(row.definition);
  if (!parsed.ok) throw new Error(`stored workflow definition is invalid: ${parsed.error.detail}`);
  return parsed.value;
};

/**
 * A stored definition, or nothing when it can no longer be read.
 *
 * Asking for one definition by id and getting a throw is right — the caller
 * named it and cannot proceed without it. Listing them is different: a
 * definition retired by a schema change is still a row, and mapping the strict
 * decode across every row meant one unreadable row took down the whole list,
 * so the launcher offered the operator nothing at all rather than everything
 * that still works.
 */
const decodeListedDefinition = (row: DefinitionRow): WorkflowDefinition | null => {
  const parsed = parseWorkflowDefinition(row.definition);
  if (parsed.ok) return parsed.value;
  console.warn(`oakridge: omitting a stored workflow definition that no longer parses: ${parsed.error.detail}`);
  return null;
};

export class PostgresWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  constructor(private readonly sql: SqlExecutor) {}

  async insert_immutable(definition: WorkflowDefinition): Promise<WorkflowDefinition> {
    const rows = await this.sql.query<DefinitionRow>(
      `INSERT INTO oakridge.workflow_definition (id, name, version, definition, archived, created_at)
       VALUES ($1, $2, $3, $4::jsonb, $5, $6::timestamptz)
       ON CONFLICT (name, version) DO UPDATE
         SET name = EXCLUDED.name
         WHERE oakridge.workflow_definition.definition - 'archived' = EXCLUDED.definition - 'archived'
       RETURNING definition`,
      [definition.id, definition.name, definition.version, definition, definition.archived, definition.created_at],
    );
    const row = rows[0];
    if (!row) throw new Error(`workflow definition ${definition.name}@${definition.version} conflicts with immutable stored content`);
    return decodeDefinition(row);
  }

  async find_by_id(id: WorkflowDefinitionId): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE id = $1",
      [id],
    );
    return rows[0] ? decodeDefinition(rows[0]) : null;
  }

  async find_by_name_version(name: string, version: number): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE name = $1 AND version = $2",
      [name, version],
    );
    return rows[0] ? decodeDefinition(rows[0]) : null;
  }

  async list(include_archived = false): Promise<readonly WorkflowDefinition[]> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE $1::boolean OR NOT archived ORDER BY name, version DESC",
      [include_archived],
    );
    return rows.map(decodeListedDefinition).filter((definition): definition is WorkflowDefinition => definition !== null);
  }

  async set_archived(id: WorkflowDefinitionId, archived: boolean): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      `UPDATE oakridge.workflow_definition
       SET archived = $2, definition = jsonb_set(definition, '{archived}', to_jsonb($2::boolean), true)
       WHERE id = $1
       RETURNING definition`,
      [id, archived],
    );
    return rows[0] ? decodeDefinition(rows[0]) : null;
  }
}
