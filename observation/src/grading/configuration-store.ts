import { constants } from "node:fs";
import { lstat, mkdir, open, readdir, rename, link, unlink } from "node:fs/promises";
import { resolve, join } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalDigest } from "canonical-json";
import { err, ok, type Result } from "../domain/primitives";
import { configurationDocumentSchema, configurationHash, type DraftConfiguration, type PublishedConfiguration, type GradingDefinitions } from "./configuration";

interface StoredJsonDocument { readonly document: unknown }
export interface StoredDraft { readonly document: DraftConfiguration; readonly digest: string }
interface StoreErrorContext { readonly operation: "grading_config_store"; readonly entity_id: string; readonly detail: string }
export type ConfigurationStoreError = StoreErrorContext & (
  | { readonly kind: "draft_conflict"; readonly current_digest: string | null }
  | { readonly kind: "io" | "invalid_document" | "invalid_version" }
);
export interface PublishedWrite { readonly definitions: GradingDefinitions; readonly published_at: string }
/** These operations share the store's lock when used in a transaction. No operation takes a file name. */
export interface ConfigurationStoreTransaction {
  readDraft(): Promise<Result<StoredDraft | null, ConfigurationStoreError>>;
  saveDraft(expected_digest: string | null, document: DraftConfiguration): Promise<Result<StoredDraft, ConfigurationStoreError>>;
  listVersions(): Promise<Result<readonly number[], ConfigurationStoreError>>;
  readVersion(version: number): Promise<Result<PublishedConfiguration | null, ConfigurationStoreError>>;
  latestVersion(): Promise<Result<PublishedConfiguration | null, ConfigurationStoreError>>;
  allocateAndWritePublished(input: PublishedWrite): Promise<Result<PublishedConfiguration, ConfigurationStoreError>>;
}
export interface GradingConfigStore extends ConfigurationStoreTransaction {
  withLock<T>(work: (store: ConfigurationStoreTransaction) => Promise<T>): Promise<T>;
}
const failure = (kind: "io" | "invalid_document" | "invalid_version", entity_id: string, detail: string): Result<never, ConfigurationStoreError> =>
  err({ operation: "grading_config_store", kind, entity_id, detail });
const codeOf = (cause: unknown): string | undefined => cause instanceof Error && "code" in cause ? String(cause.code) : undefined;
const detailOf = (cause: unknown): string => cause instanceof Error ? cause.message : String(cause);
const validVersion = (version: number): boolean => Number.isInteger(version) && version > 0 && version <= 999999;

/**
 * One confined directory with immutable history, atomic writes, and an in-process transaction mutex.
 * The root and its versions directory must be real directories, not symbolic links.
 * Callers binding an environment-provided root must pass a non-symlink directory (or use realpath first).
 * Reads never create directories: missing roots/history return absent documents or an empty version list.
 * Writes create the directories they need; saving a draft never creates the versions directory.
 */
export function createGradingConfigStore(root: string): GradingConfigStore {
  const directory = resolve(root);
  const versions = join(directory, "versions");
  const draft = join(directory, "draft.json");
  const versionPath = (version: number): string => join(versions, `${String(version).padStart(6, "0")}.json`);
  let tail: Promise<void> = Promise.resolve();
  const withLock = async <T>(work: (store: ConfigurationStoreTransaction) => Promise<T>): Promise<T> => {
    const previous = tail;
    let release!: () => void;
    tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(transaction); } finally { release(); }
  };
  const checkDirectory = async (path: string): Promise<void> => {
    if (!(await lstat(path)).isDirectory()) throw new Error("configuration directory must not be a symbolic link");
  };
  const ensureDirectory = async (path: string): Promise<void> => {
    await mkdir(path, { recursive: true });
    await checkDirectory(path);
  };
  const checkDirectories = async (is_version: boolean): Promise<void> => {
    await checkDirectory(directory);
    if (is_version) await checkDirectory(versions);
  };
  const prepare = async (is_version: boolean): Promise<void> => {
    await ensureDirectory(directory);
    if (is_version) await ensureDirectory(versions);
  };
  const read = async (path: string, is_version = false): Promise<Result<StoredJsonDocument | null, ConfigurationStoreError>> => {
    try {
      await checkDirectories(is_version);
      const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
      try { return ok({ document: JSON.parse(await file.readFile("utf8")) as unknown }); } finally { await file.close(); }
    } catch (cause) { return codeOf(cause) === "ENOENT" ? ok(null) : failure("io", path, detailOf(cause)); }
  };
  const write = async (path: string, document: DraftConfiguration | PublishedConfiguration, exclusive: boolean): Promise<Result<void, ConfigurationStoreError>> => {
    const targetDirectory = exclusive ? versions : directory;
    const temporary = join(targetDirectory, `.tmp-${randomUUID()}`);
    try {
      await prepare(exclusive);
      const file = await open(temporary, "wx", 0o600);
      try { await file.writeFile(`${JSON.stringify(document, null, 2)}\n`); await file.sync(); } finally { await file.close(); }
      if (exclusive) { await link(temporary, path); await unlink(temporary); }
      else await rename(temporary, path);
      const parent = await open(targetDirectory, "r");
      try { await parent.sync(); } finally { await parent.close(); }
      return ok(undefined);
    } catch (cause) { return failure("io", path, detailOf(cause)); }
    finally { await unlink(temporary).catch(() => undefined); }
  };
  const readDraft: ConfigurationStoreTransaction["readDraft"] = async () => {
    const raw = await read(draft);
    if (!raw.ok) return raw;
    if (raw.value === null) return ok(null);
    const parsed = configurationDocumentSchema.safeParse(raw.value.document);
    if (!parsed.success || parsed.data.status !== "draft") return failure("invalid_document", "draft", "expected a draft document");
    const digest = canonicalDigest(parsed.data);
    return digest.ok ? ok({ document: parsed.data, digest: digest.value }) : failure("invalid_document", "draft", digest.error.detail);
  };
  const listVersions: ConfigurationStoreTransaction["listVersions"] = async () => {
    try {
      await checkDirectories(true);
      return ok((await readdir(versions)).filter((name) => /^\d{6}\.json$/.test(name))
        .map((name) => Number(name.slice(0, 6))).filter(validVersion).sort((left, right) => left - right));
    } catch (cause) { return codeOf(cause) === "ENOENT" ? ok([]) : failure("io", "versions", detailOf(cause)); }
  };
  const readVersion: ConfigurationStoreTransaction["readVersion"] = async (version) => {
    if (!validVersion(version)) return failure("invalid_version", String(version), "version must be an integer from 1 to 999999");
    const raw = await read(versionPath(version), true);
    if (!raw.ok) return raw;
    if (raw.value === null) return ok(null);
    const parsed = configurationDocumentSchema.safeParse(raw.value.document);
    if (!parsed.success || parsed.data.status !== "published" || parsed.data.version !== version)
      return failure("invalid_document", String(version), "expected matching published version");
    const hash = configurationHash(parsed.data.definitions);
    if (!hash.ok || hash.value !== parsed.data.hash) return failure("invalid_document", String(version), "published hash mismatch");
    return ok(parsed.data);
  };
  const latestVersion: ConfigurationStoreTransaction["latestVersion"] = async () => {
    const listed = await listVersions();
    if (!listed.ok) return listed;
    const version = listed.value.at(-1);
    return version === undefined ? ok(null) : readVersion(version);
  };
  const transaction: ConfigurationStoreTransaction = {
    readDraft, listVersions, readVersion, latestVersion,
    async saveDraft(expected_digest, document) {
      const current = await readDraft();
      if (!current.ok) return current;
      const current_digest = current.value?.digest ?? null;
      if (expected_digest !== current_digest) return err({ operation: "grading_config_store", kind: "draft_conflict",
        entity_id: "draft", detail: "draft changed since it was read", current_digest });
      const parsed = configurationDocumentSchema.safeParse(document);
      if (!parsed.success || parsed.data.status !== "draft") return failure("invalid_document", "draft", "expected a draft document");
      const digest = canonicalDigest(parsed.data);
      if (!digest.ok) return failure("invalid_document", "draft", digest.error.detail);
      const written = await write(draft, parsed.data, false);
      return written.ok ? ok({ document: parsed.data, digest: digest.value }) : written;
    },
    async allocateAndWritePublished(input) {
      const latest = await listVersions();
      if (!latest.ok) return latest;
      const version = (latest.value.at(-1) ?? 0) + 1;
      if (!validVersion(version)) return failure("invalid_version", String(version), "version history is full");
      const hash = configurationHash(input.definitions);
      if (!hash.ok) return failure("invalid_document", String(version), hash.error.detail);
      const document: PublishedConfiguration = { status: "published", version, hash: hash.value, ...input };
      if (!configurationDocumentSchema.safeParse(document).success) return failure("invalid_document", String(version), "invalid published document");
      const written = await write(versionPath(version), document, true);
      return written.ok ? ok(document) : written;
    },
  };
  return {
    withLock,
    readDraft: () => withLock((store) => store.readDraft()),
    saveDraft: (digest, document) => withLock((store) => store.saveDraft(digest, document)),
    listVersions: () => withLock((store) => store.listVersions()),
    readVersion: (version) => withLock((store) => store.readVersion(version)),
    latestVersion: () => withLock((store) => store.latestVersion()),
    allocateAndWritePublished: (input) => withLock((store) => store.allocateAndWritePublished(input)),
  };
}
