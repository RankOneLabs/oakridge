import { readdir, readFile } from "node:fs/promises";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { ChipTone } from "../../components/atoms/Chip";
import type { AssessmentVerdict, ArtifactRevisionStatus, FindingSeverity, RunDisplayStatus, RunStatus, StageStatus, StageUnitStatus } from "../types";
import { selectStatusTone, type StatusToneSource } from "./status-tone";

const run = {
  pending: "muted", running: "info", parked: "warning", failed: "danger",
  complete: "success", cancelled: "muted",
} satisfies Record<RunStatus, ChipTone>;
const stage = {
  pending: "muted", running: "info", parked: "warning", failed: "danger", complete: "success",
} satisfies Record<StageStatus, ChipTone>;
const unit = {
  pending: "muted", running: "info", parked: "warning", failed: "danger", complete: "success",
} satisfies Record<StageUnitStatus, ChipTone>;
const display = { ...run, stuck: "warning" } satisfies Record<RunDisplayStatus, ChipTone>;
const artifact = { draft: "warning", approved: "success", rejected: "danger" } satisfies Record<ArtifactRevisionStatus, ChipTone>;
const severity = { blocking: "danger", warning: "warning", info: "info" } satisfies Record<FindingSeverity, ChipTone>;
const verdict = { pass: "success", pass_with_notes: "warning", fail: "danger" } satisfies Record<AssessmentVerdict, ChipTone>;

describe("selectStatusTone", () => {
  it("maps every member of the API status unions", () => {
    for (const mapping of [run, stage, unit, display, artifact, severity, verdict]) {
      for (const [status, tone] of Object.entries(mapping)) {
        expect(selectStatusTone(status as StatusToneSource)).toBe(tone);
      }
    }
  });
});

const pwaRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
async function sourceFilesBelow(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = await Promise.all(entries.map(async (entry): Promise<string[]> => {
    const path = resolve(directory, entry.name);
    if (entry.isDirectory() && entry.name !== "dist" && entry.name !== "node_modules") return sourceFilesBelow(path);
    return entry.isFile() && /\.tsx$/.test(entry.name) && !/\.test\./.test(entry.name) ? [path] : [];
  }));
  return files.flat();
}

it("reserves the bare Button variant for CompactControl", async () => {
  const files = await sourceFilesBelow(pwaRoot);
  const sources = await Promise.all(files.map(async (path) => ({ path, source: await readFile(path, "utf8") })));
  const users = sources.filter(({ source }) => /variant\s*=\s*["']bare["']/.test(source))
    .map(({ path }) => relative(pwaRoot, path));
  expect(users).toEqual(["components/molecules/CompactControl.tsx"]);
});
