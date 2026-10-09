import type { CoreClient } from "../core-client/client";
import type { DefinitionBundle, LifecyclePayloadProjection, ScopeDefinition } from "../core-client/generated-contracts";
import { prepareLifecycleTrigger } from "../storage/lifecycle-trigger";
import type { MutationService } from "../storage/mutation-service";
import type { ChildCollectionRecord, RunId, ScopeId, ScopeInstanceRecord, ScopeExportRecord } from "../storage/schema-records";
import type { TransactionalSqlExecutor } from "../storage/sql-executor";

interface RunBundle { readonly run_id: RunId; readonly source: DefinitionBundle }
export interface LifecycleFailure { readonly scope_id: string; readonly detail: string }
export interface ChildAdvancementInput {
  readonly db: TransactionalSqlExecutor;
  readonly core: CoreClient;
  readonly mutations: MutationService;
  /** Omitted for periodic recovery of all active runs. */
  readonly run_ids?: readonly RunId[];
}
export interface ChildAdvancementPageInput extends ChildAdvancementInput {
  readonly after_scope_id: string | null;
  readonly max_scopes: number;
  readonly per_scope_deadline_ms: number;
  readonly max_request_deadline_ms: number;
}
export interface ChildAdvancementPage { readonly failures: readonly LifecycleFailure[]; readonly next_cursor: string | null }
export function serialChildrenRequestDeadlineMs(children: number, per_call_ms: number, cap_ms: number): number {
  return Math.min(children * per_call_ms, cap_ms);
}
function groupChildCollections(collections: readonly ChildCollectionRecord[]): ReadonlyMap<ScopeId, readonly ChildCollectionRecord[]> {
  const grouped = new Map<ScopeId, ChildCollectionRecord[]>();
  for (const collection of collections) {
    const siblings = grouped.get(collection.scope_id) ?? [];
    siblings.push(collection);
    grouped.set(collection.scope_id, siblings);
  }
  return grouped;
}

interface ChildDeclaration {
  readonly child: ScopeDefinition["children"][number] | undefined;
  readonly dependencies: readonly string[];
}
interface ChildDeclarationInput {
  readonly scope: ScopeInstanceRecord;
  readonly parent_definition: ScopeDefinition | undefined;
  readonly collections: readonly ChildCollectionRecord[];
}
function childDeclaration({ scope, parent_definition, collections }: ChildDeclarationInput): ChildDeclaration {
  let child = parent_definition?.children.find((item) => item.key === scope.collection_key || (!scope.collection_key && item.key === scope.child_key));
  let dependencies: readonly string[] = child?.depends_on ?? [];
  if (!child || scope.collection_key) {
    for (const collection of collections) {
      const member = collection.members.find((member) => typeof member === "string" ? member === scope.id : member.id === scope.id);
      if (!member) continue;
      child = parent_definition?.children.find((item) => item.key === collection.collection_key);
      dependencies = typeof member === "string" ? [] : member.depends_on;
      break;
    }
  }
  return { child, dependencies };
}
interface ChildPageContext {
  readonly selected: readonly ScopeInstanceRecord[];
  readonly scopes: readonly ScopeInstanceRecord[];
  readonly collections: readonly ChildCollectionRecord[];
  readonly empty_collections: readonly ChildCollectionRecord[];
  readonly exports: readonly ScopeExportRecord[];
  readonly has_more: boolean;
}
interface ChildPageRead {
  readonly db: TransactionalSqlExecutor;
  readonly bundles: ReadonlyMap<RunId, DefinitionBundle>;
  readonly run_ids: readonly RunId[];
  readonly after_scope_id: string | null;
  readonly max_scopes: number;
}
interface ChildDependencyRead { readonly parent_id: ScopeId; readonly key: string; readonly collection_key: string | null }
/** Fetch one page plus its parents and declared prerequisites, never the whole run. */
async function readChildPage(input: ChildPageRead): Promise<ChildPageContext> {
  const { db } = input;
  const page = await db.query<ScopeInstanceRecord>(`SELECT * FROM authority.scope_instance
    WHERE run_id=ANY($1::text[]) AND ($2::text IS NULL OR id > $2)
    ORDER BY id LIMIT $3`, [input.run_ids, input.after_scope_id, input.max_scopes + 1]);
  const selected = page.slice(0, input.max_scopes);
  const selected_ids = selected.map((scope) => scope.id);
  const parent_ids = [...new Set(selected.flatMap((scope) => scope.parent_id ? [scope.parent_id] : []))];
  const parents = await db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE id=ANY($1::text[]) ORDER BY id", [parent_ids]);
  const parents_by_id = new Map(parents.map((scope) => [scope.id, scope]));
  // Dynamic membership metadata is needed only for selected children. Do not transfer all siblings.
  const memberships = await db.query<ChildCollectionRecord>(`SELECT c.id,c.scope_id,c.collection_key,c.version,
      jsonb_agg(member.value) AS members
    FROM authority.child_collection c CROSS JOIN LATERAL jsonb_array_elements(c.members) member(value)
    WHERE c.scope_id=ANY($1::text[]) AND coalesce(member.value->>'id',member.value #>> '{}')=ANY($2::text[])
    GROUP BY c.id ORDER BY c.id`, [parent_ids, selected_ids]);
  const membership_by_parent = groupChildCollections(memberships);
  const dependencies: ChildDependencyRead[] = selected.flatMap((scope) => {
    const parent = scope.parent_id ? parents_by_id.get(scope.parent_id) : undefined;
    if (!parent) return [];
    const definition = input.bundles.get(parent.run_id)?.scopes.find((item) => item.key === parent.scope_key);
    const declaration = childDeclaration({ scope, parent_definition: definition, collections: membership_by_parent.get(parent.id as ScopeId) ?? [] });
    return declaration.dependencies.map((key) => ({ parent_id: parent.id as ScopeId, key, collection_key: scope.collection_key ?? null }));
  });
  const dependency_collections = await db.query<ChildCollectionRecord>(`SELECT DISTINCT c.* FROM authority.child_collection c
    JOIN jsonb_to_recordset($1::jsonb) AS d(parent_id text,key text,collection_key text)
      ON c.scope_id=d.parent_id AND c.collection_key=d.key ORDER BY c.id`, [JSON.stringify(dependencies)]);
  const dependency_ids = [...new Set(dependency_collections.flatMap((collection) => collection.members.map((member) => typeof member === "string" ? member : member.id)))];
  const required_scopes = await db.query<ScopeInstanceRecord>(`SELECT s.* FROM authority.scope_instance s
    WHERE s.id=ANY($1::text[])
    UNION SELECT s.* FROM jsonb_to_recordset($2::jsonb) AS d(parent_id text,key text,collection_key text)
      JOIN authority.scope_instance s ON s.parent_id=d.parent_id AND s.child_key=d.key
        AND s.collection_key IS NOT DISTINCT FROM d.collection_key
    ORDER BY id`, [dependency_ids, JSON.stringify(dependencies)]);
  const exports = await db.query<ScopeExportRecord>("SELECT * FROM authority.scope_export WHERE scope_id=ANY($1::text[]) ORDER BY id", [required_scopes.map((scope) => scope.id)]);
  const empty_collections = await db.query<ChildCollectionRecord>("SELECT * FROM authority.child_collection WHERE scope_id=ANY($1::text[]) AND members='[]'::jsonb ORDER BY id", [selected_ids]);
  // Prefer complete dependency collections when a collection is also membership context.
  const collections = [...new Map([...memberships, ...dependency_collections, ...empty_collections].map((collection) => [collection.id, collection])).values()];
  const scopes = [...new Map([...parents, ...required_scopes, ...selected].map((scope) => [scope.id, scope])).values()];
  return { selected, scopes, collections, empty_collections, exports, has_more: page.length > selected.length };
}

/**
 * Entry and completion triggers are declared in the bundle and delivered through
 * receipts. A scope whose trigger is rejected is reported, not thrown: one bad
 * scope never stops the others in the same pass.
 */
export async function advanceChildren(input: ChildAdvancementInput): Promise<readonly LifecycleFailure[]> {
  return (await advanceChildrenInternal(input)).failures;
}
export async function advanceChildrenPage(input: ChildAdvancementPageInput): Promise<ChildAdvancementPage> {
  return advanceChildrenInternal(input);
}
async function advanceChildrenInternal({ db, core, mutations, run_ids, ...page }: ChildAdvancementInput & Partial<ChildAdvancementPageInput>): Promise<ChildAdvancementPage> {
  const failures: LifecycleFailure[] = [];
  const report = (scope_id: string, error: unknown): void => { failures.push({ scope_id, detail: error instanceof Error ? error.message : String(error) }); };
  const runs = await db.query<RunBundle>(`SELECT r.id AS run_id,b.source FROM authority.run r
    JOIN authority.definition_bundle b ON b.id=r.definition_bundle_id
    WHERE ($1::text[] IS NULL OR r.id=ANY($1)) AND EXISTS (
      SELECT 1 FROM authority.scope_instance root WHERE root.run_id=r.id AND root.parent_id IS NULL AND NOT root.is_terminal
    ) ORDER BY r.id`, [run_ids ?? null]);
  if (!runs.length) return { failures, next_cursor: null };
  const active_run_ids = runs.map((run) => run.run_id);
  const bundles = new Map(runs.map((run) => [run.run_id, run.source]));
  const context = page.max_scopes === undefined ? null : await readChildPage({ db, bundles,
    run_ids: active_run_ids, after_scope_id: page.after_scope_id ?? null, max_scopes: page.max_scopes });
  const scopes = context?.scopes ?? await db.query<ScopeInstanceRecord>("SELECT * FROM authority.scope_instance WHERE run_id=ANY($1::text[]) ORDER BY id", [active_run_ids]);
  const scopes_by_id = new Map(scopes.map((scope) => [scope.id, scope]));
  const all_collections = context?.collections ?? await db.query<ChildCollectionRecord>(`SELECT c.* FROM authority.child_collection c
    JOIN authority.scope_instance s ON s.id=c.scope_id WHERE s.run_id=ANY($1::text[]) ORDER BY c.id`, [active_run_ids]);
  const collections_by_parent = groupChildCollections(all_collections);
  const exports = context?.exports ?? await db.query<ScopeExportRecord>(`SELECT e.* FROM authority.scope_export e
    JOIN authority.scope_instance s ON s.id=e.scope_id WHERE s.run_id=ANY($1::text[]) ORDER BY e.id`, [active_run_ids]);
  const selected = context?.selected ?? scopes;
  const deadline_at = page.per_scope_deadline_ms === undefined || page.max_request_deadline_ms === undefined ? Infinity
    : Date.now() + serialChildrenRequestDeadlineMs(selected.length, page.per_scope_deadline_ms, page.max_request_deadline_ms);
  let processed = 0;
  for (const scope of selected) {
    if (processed > 0 && Date.now() >= deadline_at) break;
    try { await advanceScope(scope); } catch (error) { report(scope.id, error); }
    processed++;
  }
  const last_scope_id = processed ? selected[processed - 1]!.id : page.after_scope_id ?? null;
  const next_cursor = processed < selected.length || context?.has_more ? last_scope_id : null;
  const processed_scope_ids = new Set(selected.slice(0, processed).map((scope) => scope.id));
  const empty_collections = (context?.empty_collections ?? all_collections.filter((collection) => collection.members.length === 0))
    .filter((collection) => processed_scope_ids.has(collection.scope_id));
  for (const collection of empty_collections) {
    const parent = scopes_by_id.get(collection.scope_id);
    if (!parent || parent.is_terminal) continue;
    const definition = bundles.get(parent.run_id)?.scopes.find((item) => item.key === parent.scope_key);
    const child = definition?.children.find((item) => item.key === collection.collection_key);
    const fact = definition?.facts.find((item) => item.key === child?.on_terminal);
    if (!fact) continue;
    try { await deliver(parent, fact.key, `empty-collection:${collection.id}`, fact.payload_schema, child?.on_terminal_payload); } catch (error) { report(parent.id, error); }
  }
  return { failures, next_cursor };

  async function advanceScope(scope: ScopeInstanceRecord): Promise<void> {
    const bundle = bundles.get(scope.run_id);
    const definition = bundle?.scopes.find((item) => item.key === scope.scope_key);
    const parent = scope.parent_id ? scopes_by_id.get(scope.parent_id) : undefined;
    const parent_definition = bundle?.scopes.find((item) => item.key === parent?.scope_key);
    const collections = parent ? collections_by_parent.get(parent.id as ScopeId) ?? [] : [];
    const { child, dependencies } = childDeclaration({ scope, parent_definition, collections });
    if (!scope.is_terminal && definition?.entry_command && (!parent || !parent.is_terminal)) {
      const required = dependencies.flatMap((key) => {
        const collection = collections.find((item) => item.collection_key === key);
        if (!collection) return [scopes.find((item) => item.parent_id === parent?.id && item.child_key === key && (item.collection_key ?? null) === (scope.collection_key ?? null))];
        return collection.members.map((member) => scopes_by_id.get(typeof member === "string" ? member as ScopeId : member.id));
      });
      if (required.some((item) => !item?.is_terminal)) return;
      if (child?.prerequisite_export && required.length) {
        const succeeded = required.every((dependency) => exports.some((item) => item.scope_id === dependency?.id && item.export_key === child?.prerequisite_export && item.value.data.kind === "boolean" && item.value.data.value));
        if (!succeeded) {
          const cancellation = definition.cancellation.trigger;
          const event = definition.commands.find((item) => item.key === cancellation) ?? definition.facts.find((item) => item.key === cancellation);
          if (event) await deliver(scope, event.key, `dependency-cancel:${scope.id}`, event.payload_schema, definition.cancellation.payload);
          return;
        }
      }
      const key = definition.entry_command;
      const command = definition.commands.find((item) => item.key === key);
      if (!command) return;
      const state = scope.local_state.data.kind === "variant" || scope.local_state.data.kind === "enum" ? scope.local_state.data.variant : null;
      if (!state || !command.available_in.includes(state)) return;
      await deliver(scope, key, `entry:${scope.id}`, command.payload_schema, definition.entry_payload);
    }
    if (scope.is_terminal && parent && !parent.is_terminal && child?.on_terminal) {
      const fact = parent_definition?.facts.find((fact) => fact.key === child?.on_terminal);
      if (fact) await deliver(parent, fact.key, `child-terminal:${scope.id}`, fact.payload_schema, child.on_terminal_payload);
    }
  }
  async function deliver(scope: ScopeInstanceRecord, key: string, id: string, schema: string, projection?: LifecyclePayloadProjection): Promise<void> {
    const bundle = bundles.get(scope.run_id);
    if (!bundle) throw new Error(`lifecycle bundle missing: ${scope.run_id}`);
    const prepared = await prepareLifecycleTrigger({ core, bundle, id, key, schema, projection, reason: id });
    if (!prepared.ok) throw new Error(`invalid configured lifecycle payload: ${scope.id}/${key}: ${prepared.error.detail}`);
    // advanceRunStep may retry an infrastructure failure five times, so one
    // outer step can issue at most 5 × 3 decisions. A third Conflict becomes a
    // run diagnostic and does not consume the outer infrastructure retries.
    const max_conflict_attempts = 3;
    for (let attempt = 1; attempt <= max_conflict_attempts; attempt++) {
      const result = await mutations.decide({ run_id: scope.run_id, scope_id: scope.id as ScopeId, ingress_id: id,
        trigger: prepared.value, operator_version: null });
      if (!result.ok) throw new Error(`${result.error.operation}/${result.error.entity_id}: ${result.error.detail}`);
      const outcome = result.value;
      switch (outcome.kind) {
        case "Committed": case "Replayed": return;
        case "Conflict":
          if (attempt === max_conflict_attempts) throw new Error(`lifecycle trigger ${key} for scope ${scope.id}: Conflict after ${attempt} attempts`);
          await Bun.sleep(10 * attempt + Math.random() * 20);
          break;
        case "Rejected":
          if (outcome.reason === "owner_terminal" || outcome.reason === "capacity_unavailable") return;
          throw new Error(outcome.detail);
        case "snapshot_too_large":
          throw new Error(`snapshot_too_large: ${outcome.scope} ${outcome.bytes}/${outcome.limit}`);
        default: { const unhandled: never = outcome; throw new Error(`unhandled commit outcome: ${JSON.stringify(unhandled)}`); }
      }
    }
  }
}
