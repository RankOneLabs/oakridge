import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { canonicalJson } from "../../../canonical-json/src/index";
import { acpError, err, ok, type AcpError, type Result } from "./types";

export interface SessionSkillInput {
  readonly digest: string | null;
  /** The content-addressed skills directory, containing one directory per digest. */
  readonly skillStoreRoot: string;
  readonly sessionSkillsRoot: string;
  readonly sid: string;
}
export interface MaterializedSessionSkill { readonly directory: string | null }
interface BundleFile { readonly path: string; readonly bytes: Uint8Array }
const digestBytes = (bytes: Uint8Array): string => createHash("sha256").update(bytes).digest("hex");

/** Verify the complete manifest before writing either runtime's discovery layout. */
export function materializeSessionSkill(input: SessionSkillInput): Result<MaterializedSessionSkill, AcpError> {
  if (input.digest === null) return ok({ directory: null });
  const unavailable = (detail: string): Result<never, AcpError> => err(acpError(
    "skill_unavailable", "materializeSessionSkill", `skill ${input.digest}: ${detail}`,
  ));
  if (!/^[a-f0-9]{64}$/.test(input.digest)) return unavailable("invalid digest");
  if (!/^[a-zA-Z0-9_-]+$/.test(input.sid)) return unavailable("invalid session id");
  try {
    const root = realpathSync(input.skillStoreRoot);
    const bundle = join(root, input.digest);
    const files: BundleFile[] = [];
    const collect = (directory: string, prefix: string): void => {
      if (realpathSync(directory) !== directory) throw new Error("symlink in bundle");
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        const name = prefix + entry.name;
        if (entry.isSymbolicLink()) throw new Error("symlink in bundle");
        if (entry.isDirectory()) collect(path, name + "/");
        else if (entry.isFile()) files.push({ path: name, bytes: readFileSync(path) });
        else throw new Error("bundle entry is not a regular file");
      }
    };
    collect(bundle, "");
    const manifest = canonicalJson({ files: Object.fromEntries(files.map(file => [file.path, digestBytes(file.bytes)])) });
    if (!manifest.ok || digestBytes(new TextEncoder().encode(manifest.value)) !== input.digest)
      return unavailable("bundle digest mismatch");
    if (!files.some(file => file.path === "SKILL.md")) return unavailable("missing SKILL.md");
    const directory = resolve(input.sessionSkillsRoot, input.sid);
    // Verified with claude-agent-acp 0.76.0 and codex-acp 1.13.0 using
    // ACP additionalDirectories; neither layout changes the user's config home.
    for (const container of [".claude", ".agents"]) {
      for (const file of files) {
        const destination = join(directory, container, "skills", "pr-operations", file.path);
        mkdirSync(resolve(destination, ".."), { recursive: true });
        writeFileSync(destination, file.bytes);
      }
    }
    return ok({ directory });
  } catch (cause) { return unavailable(String(cause)); }
}
