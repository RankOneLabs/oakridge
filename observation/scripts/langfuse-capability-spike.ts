import { langfuseConfigFromEnv } from "../src/langfuse/config";
import { detectLangfuseFeatures } from "../src/langfuse/feature-detection";
import { createLangfuseHttpClient } from "../src/langfuse/http-client";
import { randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";

const writeSynthetic = process.argv.includes("--write-synthetic");
const scoreName = "oakridge.phase_a.synthetic@v1";
const scoreResponse = z.object({ id: z.string().min(1) });
const queueResponse = z.object({ id: z.string().min(1), queueId: z.string(), objectId: z.string(),
  objectType: z.literal("OBSERVATION"), status: z.enum(["PENDING", "COMPLETED"]) });
const observationResponse = z.object({ data: z.array(z.object({ id: z.string() })) });
const scoresResponse = z.object({ data: z.array(z.object({ id: z.string(), name: z.string(),
  source: z.string(), value: z.union([z.number(), z.string(), z.boolean()]),
  subject: z.object({ kind: z.string(), id: z.string(), traceId: z.string().optional() }) })) });
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Run read-only first, then --write-synthetic against the provisioned pilot project. */
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
    else if (writeSynthetic) {
      const queueId = configuration.value.config.annotation_queue_id;
      const nativeScoreName = configuration.value.config.phase_a_jev_score_name;
      const model = configuration.value.config.decision_model;
      if (!queueId || !nativeScoreName || !model) {
        console.error("Verified annotation queue ID, pinned decision model, and native Jev score name are required for the synthetic probe");
        process.exitCode = 1;
      }
      else {
        const traceId = randomBytes(16).toString("hex");
        const observationId = randomBytes(8).toString("hex");
        const start = BigInt(Date.now()) * 1_000_000n;
        const startTime = Date.now();
        const write = await client.request({ operation: "phase_a_trace", entity_id: traceId, method: "POST",
          path: "/api/public/otel/v1/traces", response: z.object({}), body: { resourceSpans: [{ scopeSpans: [{
            spans: [{ traceId, spanId: observationId, name: "oakridge-phase-a-synthetic",
              startTimeUnixNano: start.toString(), endTimeUnixNano: (start + 1_000_000n).toString(),
              attributes: [{ key: "langfuse.observation.input", value: { stringValue: "Synthetic Phase A test only" } },
                { key: "langfuse.observation.output", value: { stringValue: "Synthetic observation" } }] }],
          }] }] } });
        if (!write.ok) { console.error(write.error.detail); process.exitCode = 1; }
        else {
          const score = await client.request({ operation: "phase_a_score", entity_id: traceId, method: "POST",
            path: "/api/public/scores", response: scoreResponse, body: { id: randomUUID(), traceId,
              observationId, name: scoreName, value: 1, dataType: "BOOLEAN", comment: "Synthetic Phase A test" } });
          if (!score.ok) { console.error(score.error.detail); process.exitCode = 1; }
          else {
            const queued = await client.request({ operation: "phase_a_queue", entity_id: observationId,
              method: "POST", path: `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items`,
              response: queueResponse, body: { objectId: observationId, objectType: "OBSERVATION", status: "PENDING" } });
            if (!queued.ok) { console.error(queued.error.detail); process.exitCode = 1; }
            else {
              console.log(JSON.stringify({ trace_id: traceId, observation_id: observationId,
                score_id: score.value.id, queue_item_id: queued.value.id,
                annotation_instruction: "Complete this queue item manually in Langfuse during the five-minute readback window." }, null, 2));
              let observedAt: number | null = null;
              let scoreAt: number | null = null;
              let nativeScoreAt: number | null = null;
              let nativeScoreId: string | null = null;
              let annotationAt: number | null = null;
              for (let attempt = 0; attempt < 60 && (observedAt === null || scoreAt === null || nativeScoreAt === null || annotationAt === null); attempt++) {
                const from = new Date(startTime - 60_000).toISOString();
                const to = new Date(Date.now() + 60_000).toISOString();
                const observations = await client.request({ operation: "phase_a_observation_read", entity_id: traceId,
                  method: "GET", path: `/api/public/v2/observations?${new URLSearchParams({ traceId,
                    fromStartTime: from, toStartTime: to, limit: "100" })}`, response: observationResponse });
                if (observations.ok && observations.value.data.some((item) => item.id === observationId)) observedAt ??= Date.now();
                const scores = await client.request({ operation: "phase_a_score_read", entity_id: score.value.id,
                  method: "GET", path: `/api/public/v3/scores?${new URLSearchParams({ id: score.value.id,
                    traceId, observationId, fields: "subject", limit: "100" })}`, response: scoresResponse });
                if (scores.ok && scores.value.data.some((item) => item.id === score.value.id && item.name === scoreName
                  && item.subject.id === observationId && item.subject.traceId === traceId)) scoreAt ??= Date.now();
                const nativeScores = await client.request({ operation: "phase_a_jev_score_read", entity_id: traceId,
                  method: "GET", path: `/api/public/v3/scores?${new URLSearchParams({ name: nativeScoreName,
                    source: "EVAL", traceId, observationId, fields: "subject", limit: "100" })}`,
                  response: scoresResponse });
                const native = nativeScores.ok ? nativeScores.value.data.find((item) => item.name === nativeScoreName
                  && item.source === "EVAL" && item.subject.id === observationId && item.subject.traceId === traceId) : null;
                if (native) { nativeScoreAt ??= Date.now(); nativeScoreId = native.id; }
                const queueState = await client.request({ operation: "phase_a_annotation_read", entity_id: queued.value.id,
                  method: "GET", path: `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items/${encodeURIComponent(queued.value.id)}`,
                  response: queueResponse });
                if (queueState.ok && queueState.value.status === "COMPLETED") annotationAt ??= Date.now();
                if (observedAt === null || scoreAt === null || nativeScoreAt === null || annotationAt === null) await sleep(5_000);
              }
              const queue = await client.request({ operation: "phase_a_annotation_read", entity_id: queued.value.id,
                method: "GET", path: `/api/public/annotation-queues/${encodeURIComponent(queueId)}/items/${encodeURIComponent(queued.value.id)}`,
                response: queueResponse });
              const annotations = await client.request({ operation: "phase_a_annotation_score_read", entity_id: queued.value.id,
                method: "GET", path: `/api/public/v3/scores?${new URLSearchParams({ queueId,
                  traceId, observationId, fields: "subject,annotation", limit: "100" })}`, response: scoresResponse });
              const manual = annotations.ok ? annotations.value.data.find((item) => item.source === "ANNOTATION"
                && item.subject.id === observationId && item.subject.traceId === traceId) : null;
              console.log(JSON.stringify({ api_versions: { observations: "v2", scores: "v3", evaluators: "v2",
                tracing: "OTLP v1" }, observed_after_ms: observedAt === null ? null : observedAt - startTime,
                score_after_ms: scoreAt === null ? null : scoreAt - startTime,
                native_jev_score_after_ms: nativeScoreAt === null ? null : nativeScoreAt - startTime,
                annotation_after_ms: annotationAt === null ? null : annotationAt - startTime,
                native_jev_score_id: nativeScoreId, native_jev_model: model,
                observation_read_path: "/api/public/v2/observations", score_read_path: "/api/public/v3/scores",
                queue_read_path: `/api/public/annotation-queues/${queueId}/items/${queued.value.id}`,
                annotation_status: queue.ok ? queue.value.status : "unavailable",
                manual_annotation_score_id: manual?.id ?? null,
                manual_annotation_value: manual?.value ?? null }, null, 2));
              if (observedAt === null || scoreAt === null || nativeScoreAt === null
                || !queue.ok || queue.value.status !== "COMPLETED" || !manual)
                process.exitCode = 1;
            }
          }
        }
      }
    }
  }
}
