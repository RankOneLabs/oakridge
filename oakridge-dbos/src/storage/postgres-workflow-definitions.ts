import type { WorkflowDefinitionId } from "../domain/primitives";
import type { PromptBundle, WorkflowDefinition } from "../domain/workflow";
import { parseWorkflowDefinition, type AdapterRoleRegistry } from "../validation/workflow-definition";
import type { WorkflowDefinitionRepository } from "./repositories";
import type { SqlExecutor, TransactionalSqlExecutor } from "./sql-executor";
import { compileWorkflowManifest } from "../compiler/compile-workflow";

interface DefinitionRow { readonly definition: unknown }

const insertPromptBundle = async (sql: SqlExecutor, bundle: PromptBundle): Promise<PromptBundle> => {
  const rows = await sql.query<{ readonly hash: string; readonly version: number; readonly matrix: PromptBundle["matrix"] }>(
    `INSERT INTO oakridge.prompt_bundle (hash,version,matrix) VALUES ($1,$2,$3::jsonb)
     ON CONFLICT (hash) DO UPDATE SET hash=EXCLUDED.hash
     WHERE oakridge.prompt_bundle.version=EXCLUDED.version AND oakridge.prompt_bundle.matrix=EXCLUDED.matrix
     RETURNING hash,version,matrix`,
    // Serialised here, not handed over as an array: `pg` renders a JS array as a
    // PostgreSQL *array* literal (`{"a","b"}`), which `::jsonb` then rejects as
    // malformed JSON. The prompt matrix is the one jsonb column in this module
    // whose value is an array, so it is the one that hit it.
    [bundle.hash, bundle.version, JSON.stringify(bundle.matrix)],
  );
  const row = rows[0];
  if (!row) throw new Error(`prompt bundle '${bundle.hash}' conflicts with stored content`);
  return { version: 1, hash: row.hash, matrix: row.matrix };
};

const bindPromptBundle = async (sql: SqlExecutor, definition_id: WorkflowDefinitionId, hash: string): Promise<void> => {
  await sql.query(
    `INSERT INTO oakridge.workflow_definition_prompt_bundle (workflow_definition_id,prompt_bundle_hash) VALUES ($1,$2)
     ON CONFLICT (workflow_definition_id) DO UPDATE SET prompt_bundle_hash=EXCLUDED.prompt_bundle_hash`, [definition_id, hash],
  );
};

const decodeDefinition = (row: DefinitionRow, adapterRoles: AdapterRoleRegistry): WorkflowDefinition => {
  const parsed = parseWorkflowDefinition(row.definition, adapterRoles);
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
const decodeListedDefinition = (row: DefinitionRow, adapterRoles: AdapterRoleRegistry): WorkflowDefinition | null => {
  const parsed = parseWorkflowDefinition(row.definition, adapterRoles);
  if (parsed.ok) return parsed.value;
  console.warn(`oakridge: omitting a stored workflow definition that no longer parses: ${parsed.error.detail}`);
  return null;
};

export class PostgresWorkflowDefinitionRepository implements WorkflowDefinitionRepository {
  constructor(private readonly sql: TransactionalSqlExecutor, private readonly adapter_roles: AdapterRoleRegistry) {}

  async insert_immutable(definition: WorkflowDefinition, promptBundle: PromptBundle): Promise<WorkflowDefinition> {
    const compiled = compileWorkflowManifest(definition, promptBundle,
      { adapter_version: "delegated-session-v1", artifact_schema_version: "v1" }, undefined, this.adapter_roles);
    if (!compiled.ok) throw new Error(`workflow definition does not compile: ${compiled.error.detail}`);
    return this.sql.transaction(async (transaction) => {
      const rows = await transaction.query<DefinitionRow>(
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
      const stored = decodeDefinition(row, this.adapter_roles);
      await insertPromptBundle(transaction, promptBundle);
      await bindPromptBundle(transaction, stored.id, promptBundle.hash);
      return stored;
    });
  }

  async insert_prompt_bundle(bundle: PromptBundle): Promise<PromptBundle> {
    return insertPromptBundle(this.sql, bundle);
  }

  async bind_prompt_bundle(definition_id: WorkflowDefinitionId, hash: string): Promise<void> {
    await bindPromptBundle(this.sql, definition_id, hash);
  }

  async find_prompt_bundle(hash: string): Promise<PromptBundle | null> {
    const rows = await this.sql.query<{ readonly hash: string; readonly version: number; readonly matrix: PromptBundle["matrix"] }>(
      "SELECT hash,version,matrix FROM oakridge.prompt_bundle WHERE hash=$1", [hash]);
    const row = rows[0];
    return row ? { version: 1, hash: row.hash, matrix: row.matrix } : null;
  }

  async find_bound_prompt_bundle(definition_id: WorkflowDefinitionId): Promise<PromptBundle | null> {
    const rows = await this.sql.query<{ readonly hash: string; readonly version: number; readonly matrix: PromptBundle["matrix"] }>(
      `SELECT bundle.hash,bundle.version,bundle.matrix
       FROM oakridge.workflow_definition_prompt_bundle binding
       JOIN oakridge.prompt_bundle bundle ON bundle.hash=binding.prompt_bundle_hash
       WHERE binding.workflow_definition_id=$1`, [definition_id]);
    const row = rows[0];
    return row ? { version: 1, hash: row.hash, matrix: row.matrix } : null;
  }

  async find_by_id(id: WorkflowDefinitionId): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE id = $1",
      [id],
    );
    return rows[0] ? decodeDefinition(rows[0], this.adapter_roles) : null;
  }

  async find_by_name_version(name: string, version: number): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE name = $1 AND version = $2",
      [name, version],
    );
    return rows[0] ? decodeDefinition(rows[0], this.adapter_roles) : null;
  }

  async list(include_archived = false): Promise<readonly WorkflowDefinition[]> {
    const rows = await this.sql.query<DefinitionRow>(
      "SELECT definition FROM oakridge.workflow_definition WHERE $1::boolean OR NOT archived ORDER BY name, version DESC",
      [include_archived],
    );
    return rows.map((row) => decodeListedDefinition(row, this.adapter_roles))
      .filter((definition): definition is WorkflowDefinition => definition !== null);
  }

  async set_archived(id: WorkflowDefinitionId, archived: boolean): Promise<WorkflowDefinition | null> {
    const rows = await this.sql.query<DefinitionRow>(
      `UPDATE oakridge.workflow_definition
       SET archived = $2, definition = jsonb_set(definition, '{archived}', to_jsonb($2::boolean), true)
       WHERE id = $1
       RETURNING definition`,
      [id, archived],
    );
    return rows[0] ? decodeDefinition(rows[0], this.adapter_roles) : null;
  }
}
