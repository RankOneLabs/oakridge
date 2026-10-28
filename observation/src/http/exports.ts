import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Hono } from "hono";
import { z } from "zod";
import { jsonlExporter } from "../export/jsonl";
import { freezeExport, prepareExport } from "../storage/export-store";
import type { SourceDependencies } from "./sources";
import { credentialFor } from "./ingest-auth";
import { errorResponse } from "./errors";

const requestSchema = z.object({
  selection: z.object({ run_id: z.string().min(1).nullable().default(null),
    occurrence_ids: z.array(z.string().min(1)).nullable().default(null) }).default({ run_id: null, occurrence_ids: null }),
  target: z.object({ name: z.string().min(1), redaction_policy: z.object({
    allow_raw_build_output: z.boolean().default(false), allow_raw_test_output: z.boolean().default(false),
    allow_repository_content: z.boolean().default(false),
  }).default({ allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false })
  }).default({ name: "assay", redaction_policy: {
    allow_raw_build_output: false, allow_raw_test_output: false, allow_repository_content: false,
  } }),
});

export function registerExportRoutes(app: Hono, deps: SourceDependencies): void {
  app.post("/v1/exports/assay", async (c) => {
    const authorization = c.req.header("authorization");
    const rawCredential = credentialFor(authorization, deps.credentials.export_raw ?? []);
    const tenant = rawCredential ?? credentialFor(authorization, deps.credentials.read);
    if (!tenant) return errorResponse(c, 403, "forbidden", "export credential required");
    let body: unknown;
    try { body = await c.req.json(); } catch { return errorResponse(c, 400, "invalid_json", "valid JSON body required"); }
    const parsed = requestSchema.safeParse(body);
    if (!parsed.success) return errorResponse(c, 400, "invalid_export", parsed.error.message);
    const allowances = parsed.data.target.redaction_policy;
    if ((allowances.allow_raw_build_output || allowances.allow_raw_test_output || allowances.allow_repository_content)
      && !rawCredential) return errorResponse(c, 403, "forbidden", "raw export credential required");
    const policy = { target_name: parsed.data.target.name, ...parsed.data.target.redaction_policy };
    const prepared = await prepareExport(deps.db, tenant, parsed.data.selection, policy);
    const root = deps.exportRoot ?? process.env.OBSERVATION_EXPORT_ROOT ?? join(tmpdir(), "observation-exports");
    const directory = join(root, prepared.manifest.manifest_id);
    try {
      const output = await jsonlExporter.export({ ...prepared, directory });
      await freezeExport(deps.db, tenant, output.manifest);
      return c.json({ manifest: output.manifest, files: { data: output.data_path, manifest: output.manifest_path } }, 201);
    } catch (error) {
      await rm(directory, { recursive: true, force: true });
      throw error;
    }
  });
}
