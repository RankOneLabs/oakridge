import { afterEach, describe, expect, it, vi } from "vitest";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useSkills, useInvokeSkill } from "./useSkills";
import type { Skill } from "../../runtime-interface";

function makeWrapper() {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  function Wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client: qc }, children);
  }
  return Wrapper;
}

const SKILL: Skill = {
  id: "skill-1",
  name: "Test Skill",
  description: "a skill",
  backend: "claude-code",
  scope: "user",
  args: [],
  user_invocable: true,
  model_invocable: false,
};

describe("useSkills", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("returns fetched skills on success", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([SKILL]),
    }));

    const { result } = renderHook(() => useSkills("sid-1"), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current).toHaveLength(1));
    expect(result.current[0].id).toBe("skill-1");
  });

  it("encodes the sid in the fetch URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve([]),
    });
    vi.stubGlobal("fetch", fetchMock);

    const { result } = renderHook(() => useSkills("s/id test"), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/s%2Fid%20test/skills");
    expect(result.current).toEqual([]);
  });

  it("returns [] when server responds non-ok", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));

    const { result } = renderHook(() => useSkills("sid-1"), {
      wrapper: makeWrapper(),
    });

    await waitFor(() => expect(result.current).toEqual([]));
  });

  it("returns [] when fetch throws (network error)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new Error("network error")));

    const { result } = renderHook(() => useSkills("sid-1"), {
      wrapper: makeWrapper(),
    });

    // hook always resolves to [] — no error state, no retry spam
    await waitFor(() => expect(result.current).toEqual([]));
  });
});

describe("useInvokeSkill", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("throws with server error message on non-ok response", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 400,
      json: () => Promise.resolve({ error: "missing required arg: topic" }),
    }));

    const { result } = renderHook(() => useInvokeSkill("sid-1"), {
      wrapper: makeWrapper(),
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ skill_id: "skill-1", args: {} });
      } catch (e) {
        thrown = e;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("missing required arg: topic");
  });

  it("throws generic message when server returns non-ok with no body", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      json: () => Promise.reject(new Error("not json")),
    }));

    const { result } = renderHook(() => useInvokeSkill("sid-1"), {
      wrapper: makeWrapper(),
    });

    let thrown: unknown;
    await act(async () => {
      try {
        await result.current.mutateAsync({ skill_id: "skill-1", args: {} });
      } catch (e) {
        thrown = e;
      }
    });

    expect(thrown).toBeInstanceOf(Error);
    expect((thrown as Error).message).toBe("server returned 500");
  });
});
