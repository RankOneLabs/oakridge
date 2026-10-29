import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { detectLangfuseFeatures } from "../src/langfuse/feature-detection";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";

/** Read-only Phase A probe. Synthetic writes require a provisioned, reviewed deployment. */
const configuration = langfuseConfigFromEnv(process.env);
if (!configuration.ok) {
  console.error(configuration.error.detail);
  process.exitCode = 1;
} else if (configuration.value.status === "disabled") {
  console.error("Langfuse is disabled; set OBSERVATION_LANGFUSE_* in the runtime secret store to run Phase A");
  process.exitCode = 2;
} else {
  const client = createLangfuseHttpClient(configuration.value.config);
  const report = await detectLangfuseFeatures(client, configuration.value.config);
  if (!report.ok) { console.error(`${report.error.capability}: ${report.error.detail}`); process.exitCode = 1; }
  else {
    console.log(JSON.stringify({ deployment: configuration.value.config.base_url,
      project_id: configuration.value.config.project_id, ...report.value }, null, 2));
    if (report.value.capabilities.some((item) => !item.available)) process.exitCode = 1;
  }
}
