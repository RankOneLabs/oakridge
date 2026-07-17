// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { PropsWithChildren } from "react";

import { useServerConfig } from "./useServerConfig";

const originalFetch = globalThis.fetch;

afterEach(() => {
  vi.restoreAllMocks();
  globalThis.fetch = originalFetch;
});

test("preserves parsed config identity across consumer rerenders", async () => {
  globalThis.fetch = vi.fn(async () =>
    new Response(
      JSON.stringify({
        defaultWorkdir: "/tmp/repo",
        defaultRuntimeId: "codex",
        runtimes: [
          {
            id: "codex",
            label: "Codex",
            supportsCompaction: false,
            models: [{ value: "gpt-5.6-sol", label: "gpt-5.6 sol" }],
          },
        ],
      }),
      { status: 200 },
    ),
  ) as unknown as typeof fetch;
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: PropsWithChildren) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );

  const { result, rerender } = renderHook(() => useServerConfig(), { wrapper });
  await waitFor(() => expect(result.current?.defaultRuntimeId).toBe("codex"));
  const parsedConfig = result.current;

  rerender();

  expect(result.current).toBe(parsedConfig);
});
