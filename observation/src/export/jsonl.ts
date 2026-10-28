import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ExperimentExporter, ExportInput, ExportOutput } from "./manifest";

export const jsonlExporter: ExperimentExporter = {
  async export(input: ExportInput): Promise<ExportOutput> {
    await mkdir(input.directory, { recursive: true });
    const data_path = join(input.directory, "candidates.jsonl");
    const manifest_path = join(input.directory, "manifest.json");
    const data = input.records.map((record) => JSON.stringify(record)).join("\n") + (input.records.length ? "\n" : "");
    const hash = `sha256:${createHash("sha256").update(data, "utf8").digest("hex")}`;
    const manifest = { ...input.manifest, file_hashes: { "candidates.jsonl": hash } };
    await writeFile(data_path, data, { flag: "wx" });
    await writeFile(manifest_path, `${JSON.stringify(manifest, null, 2)}\n`, { flag: "wx" });
    return { directory: input.directory, data_path, manifest_path, manifest };
  },
};
