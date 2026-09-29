import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { render, screen, waitFor } from "@testing-library/react";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import { ArtifactWorkspaceRedirectView } from "../views/ArtifactWorkspaceRedirectView";
import { SessionWorkspaceRedirectView } from "../views/SessionWorkspaceRedirectView";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function wrap(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

beforeEach(() => window.location.hash = "");
afterEach(() => vi.restoreAllMocks());

describe("workspace redirects", () => {
  it("resolves an artifact to its run and replaces the hash", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      id: "art-plan", run_id: "run-1", type_id: "dev.plan", revisions: [],
    }));

    wrap(<ArtifactWorkspaceRedirectView artifactId={"art-plan" as ArtifactId} onBack={() => {}} />);

    await waitFor(() => expect(window.location.hash).toBe("#oakridge/run/run-1/artifact/art-plan"));
  });

  it("renders the artifact lookup error", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "down" }, 500));

    wrap(<ArtifactWorkspaceRedirectView artifactId={"art-plan" as ArtifactId} onBack={() => {}} />);

    expect(await screen.findByTestId("or-artifact-redirect-error")).toBeTruthy();
  });

  it("resolves a session to its run and replaces the hash", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({
      run_id: "run-1", stage_instance_id: "si-build", stage_key: "build", unit_id: "c1", work_order_id: "wo-1",
    }));

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-c1" as Sid} onBack={() => {}} />);

    await waitFor(() => expect(window.location.hash).toBe("#oakridge/run/run-1/session/sid-c1"));
  });

  it("renders a 500 lookup as an error rather than a session outside a run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "down" }, 500));

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-c1" as Sid} onBack={() => {}} />);

    expect(await screen.findByTestId("or-session-redirect-error")).toBeTruthy();
    expect(screen.queryByTestId("or-session-not-in-run")).toBeNull();
  });

  it("renders a 404 lookup as a session outside a run", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ error: "not found" }, 404));

    wrap(<SessionWorkspaceRedirectView sessionId={"sid-orphan" as Sid} onBack={() => {}} />);

    expect(await screen.findByTestId("or-session-not-in-run")).toBeTruthy();
  });
});
