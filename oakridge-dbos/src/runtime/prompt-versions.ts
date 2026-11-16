import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { canonicalJson, type Result } from "canonical-json";
import { compileWorkflow, type CoreClient } from "../core-client/client";
import { bytesIdentity, jsonIdentity, isPromptPath, readLaunchableCatalog, resolveDefinition, readPromptPointer, readPromptVersion, writeStoreFile, withPublishedPrompt, DEFINITION_STORE_ROOT,
  type PromptVersionId, type PromptPointer, type PromptVersionObject, type CommittedDefinition, type DefinitionId, type LaunchableCatalog, type ResolvedDefinition } from "./definition-store";

import type { PromptIssue, PromptVersionErrorKind, PromptVersionError, ValidatePromptRequest, SavePendingPromptRequest, PublishPromptRequest, PromptVersionView, PromptVersionListing, PromptValidationOutcome, PromptMove, PromptPublicationOutcome } from "../http/prompt-versions";
export type { PromptIssue, PromptVersionErrorKind, PromptVersionError, ValidatePromptRequest, SavePendingPromptRequest, PublishPromptRequest, PromptVersionView, PromptReference, PromptVersionListing, PromptValidationOutcome, PromptMove, PromptPublicationOutcome } from "../http/prompt-versions";
type PromptResult<T> = Result<T, PromptVersionError>;
interface Referencing { readonly workflow: string; readonly resolved: ResolvedDefinition; readonly committed: CommittedDefinition }
interface PromptState { readonly root: string; readonly catalog: LaunchableCatalog; readonly references: readonly Referencing[]; readonly pointer: PromptPointer; readonly seeded: PromptVersionObject }
const storeRoot = () => process.env.OAKRIDGE_DEFINITION_ROOT ?? DEFINITION_STORE_ROOT;
function refused(kind: PromptVersionErrorKind, path: string, detail: string, issues: readonly PromptIssue[] = []): PromptResult<never> {
  return { ok: false, error: { operation: "prompt_versions", kind, entity_id: path, detail, issues } };
}
function loadState(path: string): PromptResult<PromptState> {
  if (typeof path !== "string" || !isPromptPath(path)) return refused("invalid_path", String(path), "invalid authored prompt path");
  const root = storeRoot();
  const catalog = readLaunchableCatalog(root);
  if (!catalog.ok) return refused("store_io", path, JSON.stringify(catalog.error));
  const references: Referencing[] = [];
  for (const [workflow, entry] of Object.entries(catalog.value)) {
    const resolved = resolveDefinition(entry.definition_id, root);
    if (!resolved.ok) return refused("store_io", path, JSON.stringify(resolved.error));
    if (!Object.hasOwn(resolved.value.prompts, path)) continue;
    const value = resolved.value;
    const committed: CommittedDefinition = { source: value.source, operation_registry_id: value.operation_registry_id,
      prompts: Object.fromEntries(Object.entries(value.prompts).map(([key, body]) => [key, bytesIdentity(Buffer.from(body))])),
      schema_names: value.schema_names, stage_names: value.stage_names };
    references.push({ workflow, resolved: value, committed });
  }
  if (!references.length) return refused("unknown_prompt", path, "no launchable workflow references this prompt");
  const ids = new Set(references.map(reference => reference.committed.prompts[path]));
  if (ids.size !== 1) return refused("inconsistent_published_prompt", path, "launchable workflows disagree on published prompt");
  const seeded: PromptVersionObject = { source_path: path, prompt_id: references[0].committed.prompts[path] };
  const identity = jsonIdentity<PromptVersionId>(seeded);
  if (!identity.ok) return refused("store_io", path, identity.error.detail);
  let pointer: PromptPointer = { source_path: path, published: identity.value, pending: null, history: [{ version_id: identity.value, published_at: null }] };
  if (existsSync(resolve(root, "prompt-pointers", path + ".json"))) {
    const stored = readPromptPointer(path, root);
    if (!stored.ok) return refused("store_io", path, JSON.stringify(stored.error));
    pointer = stored.value;
  }
  return { ok: true, value: { root, catalog: catalog.value, references, pointer, seeded } };
}
function writeJson(state: PromptState, path: string, value: unknown, mutable = false): PromptResult<void> {
  const canonical = canonicalJson(value);
  if (!canonical.ok) return refused("store_io", path, canonical.error.detail);
  const written = writeStoreFile({ root: state.root, path, bytes: Buffer.from(canonical.value), mutable });
  return written.ok ? written : refused("store_io", path, JSON.stringify(written.error));
}
function versionView(state: PromptState, id: PromptVersionId): PromptResult<PromptVersionView> {
  let object = state.seeded;
  const identity = jsonIdentity<PromptVersionId>(object);
  if (!identity.ok || identity.value !== id || existsSync(resolve(state.root, "prompt-versions", id + ".json"))) {
    const read = readPromptVersion(id, state.root);
    if (!read.ok) return refused("store_io", state.pointer.source_path, JSON.stringify(read.error));
    object = read.value;
  }
  try {
    const bytes = readFileSync(resolve(state.root, "prompts", object.prompt_id + ".md"));
    if (bytesIdentity(bytes) !== object.prompt_id) return refused("store_io", object.source_path, "prompt hash mismatch");
    const body = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
    return { ok: true, value: { ...object, version_id: id, body, status: id === state.pointer.published ? "published" : id === state.pointer.pending ? "pending" : "superseded",
      published_at: [...state.pointer.history].reverse().find(entry => entry.version_id === id)?.published_at ?? null } };
  } catch (cause) { return refused("store_io", object.source_path, String(cause)); }
}
export function listPromptVersions(path: string): PromptResult<PromptVersionListing> {
  const state = loadState(path); if (!state.ok) return state;
  const value = state.value;
  const published = versionView(value, value.pointer.published); if (!published.ok) return published;
  const pending = value.pointer.pending === null ? null : versionView(value, value.pointer.pending);
  if (pending && !pending.ok) return pending;
  const versions: PromptVersionView[] = [];
  const history_version_ids = [...new Set([...value.pointer.history].reverse().map(entry => entry.version_id))]
    .filter(id => id !== value.pointer.pending);
  for (const id of history_version_ids) {
    const view = versionView(value, id); if (!view.ok) return view;
    versions.push(view.value);
  }
  if (pending?.ok) versions.push({ ...pending.value, status: "pending" });
  return { ok: true, value: { source_path: path, published: published.value, pending: pending?.ok ? { ...pending.value, status: "pending" } : null,
    versions, referenced_by: value.references.map(({ workflow, resolved }) => ({ workflow, workflow_name: resolved.source.workflow, definition_id: resolved.definition_id })) } };
}
async function compileCandidate(core: CoreClient, state: PromptState, request: ValidatePromptRequest): Promise<PromptResult<PromptValidationOutcome>> {
  if (typeof request.body !== "string" || Buffer.from(request.body).toString("utf8") !== request.body) return refused("invalid_prompt", request.path, "body must encode losslessly as UTF-8");
  const issues: PromptIssue[] = [];
  for (const { workflow, resolved } of state.references) {
    const compiled = await compileWorkflow(core, { workflow: resolved.source, operations: resolved.operations, prompts: { ...resolved.prompts, [request.path]: request.body } });
    if (!compiled.ok) issues.push({ workflow, path: [workflow], detail: compiled.error.detail });
  }
  return issues.length ? refused("invalid_prompt", request.path, "candidate failed compilation", issues)
    : { ok: true, value: { valid: true, workflows: state.references.map(reference => reference.workflow) } };
}
export async function validatePrompt(core: CoreClient, request: ValidatePromptRequest): Promise<PromptResult<PromptValidationOutcome>> {
  const state = loadState(request.path); return state.ok ? compileCandidate(core, state.value, request) : state;
}
let mutationTail: Promise<unknown> = Promise.resolve();
function serialized<T>(action: () => Promise<T>): Promise<T> {
  const next = mutationTail.then(action);
  mutationTail = next.then(() => undefined, () => undefined);
  return next;
}
export function savePendingPrompt(request: SavePendingPromptRequest): Promise<PromptResult<PromptVersionView>> {
  return serialized(async () => {
    const loaded = loadState(request.path); if (!loaded.ok) return loaded;
    const state = loaded.value;
    if (state.pointer.pending !== request.expected_pending_version_id) return refused("pending_conflict", request.path, "pending version changed");
    if (typeof request.body !== "string" || Buffer.from(request.body).toString("utf8") !== request.body) return refused("invalid_prompt", request.path, "body must encode losslessly as UTF-8");
    const bytes = Buffer.from(request.body);
    const object: PromptVersionObject = { source_path: request.path, prompt_id: bytesIdentity(bytes) };
    const id = jsonIdentity<PromptVersionId>(object); if (!id.ok) return refused("store_io", request.path, id.error.detail);
    const body = writeStoreFile({ root: state.root, path: "prompts/" + object.prompt_id + ".md", bytes });
    if (!body.ok) return refused("store_io", request.path, JSON.stringify(body.error));
    const seed = jsonIdentity<PromptVersionId>(state.seeded); if (!seed.ok) return refused("store_io", request.path, seed.error.detail);
    for (const [version_id, version] of [[seed.value, state.seeded], [id.value, object]] as const) {
      const written = writeJson(state, "prompt-versions/" + version_id + ".json", version); if (!written.ok) return written;
    }
    const pointer = { ...state.pointer, pending: id.value };
    const written = writeJson(state, "prompt-pointers/" + request.path + ".json", pointer, true); if (!written.ok) return written;
    const view = versionView({ ...state, pointer }, id.value);
    return view.ok ? { ok: true, value: { ...view.value, status: "pending" } } : view;
  });
}
export function publishPrompt(core: CoreClient, request: PublishPromptRequest): Promise<PromptResult<PromptPublicationOutcome>> {
  return serialized(async () => {
    const loaded = loadState(request.path); if (!loaded.ok) return loaded;
    const state = loaded.value;
    if (state.pointer.pending !== request.expected_pending_version_id) return refused("pending_conflict", request.path, "pending version changed");
    if (state.pointer.published !== request.expected_published_version_id) return refused("published_conflict", request.path, "published version changed");
    if (state.pointer.pending === null) return refused("no_pending", request.path, "no pending version");
    const pending = versionView(state, state.pointer.pending); if (!pending.ok) return pending;
    const valid = await compileCandidate(core, state, { path: request.path, body: pending.value.body }); if (!valid.ok) return valid;
    const moved: PromptMove[] = [];
    const catalog = { ...state.catalog };
    for (const reference of state.references) {
      const committed = withPublishedPrompt(reference.committed, request.path, pending.value.prompt_id);
      const identity = jsonIdentity<DefinitionId>(committed); if (!identity.ok) return refused("store_io", request.path, identity.error.detail);
      const written = writeJson(state, "workflows/" + identity.value + ".json", committed); if (!written.ok) return written;
      const entry = catalog[reference.workflow];
      catalog[reference.workflow] = { ...entry, definition_id: identity.value };
      moved.push({ workflow: reference.workflow, workflow_name: committed.source.workflow, audience: entry.audience, previous_definition_id: entry.definition_id, definition_id: identity.value });
    }
    const published_at = new Date().toISOString();
    const catalogWrite = writeJson(state, "launchable.json", catalog, true); if (!catalogWrite.ok) return catalogWrite;
    const pointerWrite = writeJson(state, "prompt-pointers/" + request.path + ".json", { ...state.pointer, published: state.pointer.pending, pending: null,
      history: [...state.pointer.history, { version_id: state.pointer.pending, published_at }] }, true);
    if (!pointerWrite.ok) return pointerWrite;
    return { ok: true, value: { version_id: state.pointer.pending, prompt_id: pending.value.prompt_id, source_path: request.path, published_at, moved } };
  });
}
