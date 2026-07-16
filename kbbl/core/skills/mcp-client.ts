import type { McpArguments } from "./gated-review";

interface JsonRpcError {
  code: number;
  message: string;
  data?: unknown;
}

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: string | number | null;
  result?: unknown;
  error?: JsonRpcError;
}

export interface McpCallOutcome {
  result: unknown;
  isError: boolean;
}

export interface McpToolCall {
  serverName: string;
  toolName: string;
  arguments: McpArguments;
}

export type McpInvoker = (call: McpToolCall) => Promise<McpCallOutcome>;

type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

function parseResponseBody(
  text: string,
  contentType: string | null,
): JsonRpcResponse {
  if (!contentType?.includes("text/event-stream")) {
    return JSON.parse(text) as JsonRpcResponse;
  }

  const data = text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trim())
    .filter(Boolean)
    .join("\n");
  if (!data) throw new Error("MCP server returned an empty event stream");
  return JSON.parse(data) as JsonRpcResponse;
}

async function readJsonRpcResponse(response: Response): Promise<JsonRpcResponse> {
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`MCP HTTP ${response.status}${text ? `: ${text}` : ""}`);
  }
  if (!text) throw new Error("MCP server returned an empty response");
  const message = parseResponseBody(text, response.headers.get("content-type"));
  if (message.error) {
    throw new Error(`MCP ${message.error.code}: ${message.error.message}`);
  }
  return message;
}

function requestHeaders(sessionId?: string): Headers {
  const headers = new Headers({
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
  });
  if (sessionId) {
    headers.set("mcp-session-id", sessionId);
    headers.set("mcp-protocol-version", "2025-03-26");
  }
  return headers;
}

async function postJsonRpc({
  url,
  body,
  sessionId,
  fetchImpl,
}: {
  url: string;
  body: unknown;
  sessionId?: string;
  fetchImpl: FetchLike;
}): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: requestHeaders(sessionId),
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  });
}

export async function invokeHttpMcpTool({
  url,
  call,
  fetchImpl = fetch,
}: {
  url: string;
  call: McpToolCall;
  fetchImpl?: FetchLike;
}): Promise<McpCallOutcome> {
  const initializeResponse = await postJsonRpc({
    url,
    fetchImpl,
    body: {
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: {
        protocolVersion: "2025-03-26",
        capabilities: {},
        clientInfo: { name: "kbbl", version: "0.0.0" },
      },
    },
  });
  await readJsonRpcResponse(initializeResponse);
  const sessionId = initializeResponse.headers.get("mcp-session-id");
  if (!sessionId) throw new Error("MCP server did not return mcp-session-id");

  try {
    const initializedResponse = await postJsonRpc({
      url,
      sessionId,
      fetchImpl,
      body: { jsonrpc: "2.0", method: "notifications/initialized" },
    });
    if (!initializedResponse.ok) {
      throw new Error(
        `MCP initialization acknowledgement failed: ${initializedResponse.status}`,
      );
    }

    const callResponse = await postJsonRpc({
      url,
      sessionId,
      fetchImpl,
      body: {
        jsonrpc: "2.0",
        id: 2,
        method: "tools/call",
        params: {
          name: call.toolName,
          arguments: call.arguments,
        },
      },
    });
    const message = await readJsonRpcResponse(callResponse);
    const result = message.result;
    const isError =
      typeof result === "object" &&
      result !== null &&
      !Array.isArray(result) &&
      (result as { isError?: unknown }).isError === true;
    return { result, isError };
  } finally {
    void fetchImpl(url, {
      method: "DELETE",
      headers: requestHeaders(sessionId),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => undefined);
  }
}
