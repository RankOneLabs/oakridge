import { z } from "zod";
import { err, ok, type JsonValue, type Result } from "../domain/primitives";
import type { LangfuseError } from "../ports/evaluation-backend";
import type { LangfuseConfig } from "./config";

export interface LangfuseHttpError extends LangfuseError {
  readonly status: number | null;
  readonly is_transient: boolean;
}
export interface LangfuseRequest<T> {
  readonly operation: string;
  readonly entity_id: string;
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: JsonValue;
  readonly response: z.ZodType<T>;
}
export interface LangfuseHttpClient {
  request<T>(input: LangfuseRequest<T>): Promise<Result<T, LangfuseHttpError>>;
  text(path: string, operation: string): Promise<Result<string, LangfuseHttpError>>;
}

function failure(operation: string, entity_id: string, detail: string, status: number | null): LangfuseHttpError {
  return { operation, entity_id, detail, status, is_transient: status === null || status === 408 || status === 429 || status >= 500 };
}

/** One IO boundary; response bodies and exception messages are never copied into errors. */
export function createLangfuseHttpClient(config: LangfuseConfig, transport: typeof fetch = fetch): LangfuseHttpClient {
  async function send(path: string, method: "GET" | "POST", operation: string,
    entity_id: string, body?: JsonValue): Promise<Result<Response, LangfuseHttpError>> {
    if (!(path.startsWith("/api/") || path === "/generated/api/openapi.yml") || path.startsWith("//"))
      return err(failure(operation, entity_id, "invalid API path", null));
    const auth = btoa(`${config.credential.public_key}:${config.credential.secret_key}`);
    try {
      const response = await transport(`${config.base_url}${path}`, { method,
        headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/json",
          ...(path === "/api/public/otel/v1/traces" ? { "x-langfuse-ingestion-version": "4" } : {}) },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
      if (!response.ok) return err(failure(operation, entity_id, `Langfuse HTTP ${response.status}`, response.status));
      return ok(response);
    } catch {
      return err(failure(operation, entity_id, "Langfuse transport failed", null));
    }
  }
  return {
    async request<T>(input: LangfuseRequest<T>): Promise<Result<T, LangfuseHttpError>> {
      const response = await send(input.path, input.method, input.operation, input.entity_id, input.body);
      if (!response.ok) return response;
      try {
        const parsed = input.response.safeParse(await response.value.json());
        return parsed.success ? ok(parsed.data) : err(failure(input.operation, input.entity_id,
          "Langfuse response does not match the expected schema", response.value.status));
      } catch { return err(failure(input.operation, input.entity_id, "Langfuse response is not JSON", response.value.status)); }
    },
    async text(path: string, operation: string): Promise<Result<string, LangfuseHttpError>> {
      const response = await send(path, "GET", operation, "openapi");
      if (!response.ok) return response;
      try { return ok(await response.value.text()); }
      catch { return err(failure(operation, "openapi", "Langfuse response is not text", response.value.status)); }
    },
  };
}

export async function withBoundedRetry<T>(run: () => Promise<Result<T, LangfuseHttpError>>,
  settings: LangfuseConfig["retry"], sleep: (ms: number) => Promise<void> = (ms) => new Promise((resolve) => setTimeout(resolve, ms))):
  Promise<Result<T, LangfuseHttpError>> {
  for (let attempt = 1; attempt <= settings.max_attempts; attempt++) {
    const result = await run();
    if (result.ok || !result.error.is_transient || attempt === settings.max_attempts) return result;
    await sleep(settings.backoff_ms * 2 ** (attempt - 1));
  }
  return err(failure("retry", "langfuse", "retry limit reached", null));
}
