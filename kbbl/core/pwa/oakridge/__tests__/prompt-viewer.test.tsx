import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { sampleUnits } from "../__fixtures__/read-models";
import { PromptViewer } from "../components/organisms/PromptViewer";
import { StageOverviewContent } from "../components/organisms/StageOverview";
import { selectPromptView } from "../lib/prompt-view";
import { readExecutedPrompt } from "../client";
import { selectStageInputs } from "../lib/stage-overview";
import { formatRunWorkspaceHash, readHashRoute } from "../../lib/hash";
import { readStoredRunWorkspace, writeStoredRunWorkspace } from "../lib/run-workspace-storage";
import type { ExecutedPromptTurn } from "../../../executed-prompt";
import type { TurnKey } from "../../../acp/types";

const base = sampleUnits.find((unit) => unit.attempts.length > 0);
if (!base?.attempts[0]) throw new Error("Prompt fixture requires a recorded attempt");
const attempt = { ...base.attempts[0], kbbl_session_id: "retained-session", intent: { prompt: { path: "workflow-config/prompts/build.md", digest: "pinned-old-digest" }, inputs: { brief: "recorded brief" }, engine_inputs: { previous: null, subject: null, feedback: [] } } };
const unit = { ...base, attempts: [attempt] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); localStorage.clear(); });
interface PromptFixture { readonly has_session?: boolean; readonly status?: number; readonly turns?: readonly ExecutedPromptTurn[] }
const initial: ExecutedPromptTurn = { turn_id: "initial" as TurnKey, created_at: "2026-01-01", text: "Executed worker instructions\nYour publication secret: [redacted]" };
function show({ has_session = true, status = 200, turns = [initial] }: PromptFixture = {}) {
  const recorded = { ...unit, attempts: [{ ...attempt, kbbl_session_id: has_session ? attempt.kbbl_session_id : null }] };
  const fetcher = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const path = String(input);
    return path.includes("executed-prompt")
      ? Response.json(status === 404 ? { error: { code: "not_retained" } } : turns, { status })
      : Response.json([recorded]);
  });
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <PromptViewer runId={unit.run_id} unitId={unit.unit_id} attemptId={attempt.id} />
  </QueryClientProvider>);
  return fetcher;
}
it("shows three read-only sections from pinned provenance, resolved inputs and the session read", async () => {
  const fetcher = show();
  await screen.findByText(/Executed worker instructions/);
  expect(["Template", "Inputs", "Executed content"].every((name) => screen.getByRole("region", { name }))).toBe(true);
  expect(screen.getByText("pinned-old-digest")).toBeTruthy();
  expect(screen.getByText(/Pinned template content is not available by this exact digest/)).toBeTruthy();
  expect(screen.getByText(/recorded brief/)).toBeTruthy();
  expect(screen.getByText(attempt.id)).toBeTruthy();
  expect(screen.getByText(attempt.worker)).toBeTruthy();
  expect(fetcher.mock.calls.some(([path]) => String(path).includes("/sessions/retained-session/executed-prompt"))).toBe(true);
  expect(screen.queryAllByRole("textbox")).toHaveLength(0);
  expect(screen.queryByRole("button", { name: /edit|save/i })).toBeNull();
  expect(fetcher.mock.calls.some(([path]) => /prompts|definitions/.test(String(path)))).toBe(false);
});
it.each([true, false])("states not retained while preserving provenance (has session: %s)", async (has_session) => {
  const fetcher = show({ has_session, status: 404 });
  await screen.findByText("Executed content was not retained for this attempt.");
  expect(screen.getByText("pinned-old-digest")).toBeTruthy();
  if (!has_session) expect(fetcher.mock.calls.some(([path]) => String(path).includes("executed-prompt"))).toBe(false);
});
it("does not treat authorization or service failures as not retained", async () => {
  vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ error: { code: "unauthorized" } }, { status: 401 }));
  await expect(readExecutedPrompt("sid")).rejects.toThrow("401");
});
it("selects the exact recorded unit and attempt without substituting another unit's prompt", () => {
  const newer = { ...unit, unit_id: "different-unit", attempts: [{ ...attempt, intent: { ...attempt.intent, prompt: { path: "latest.md", digest: "newer-digest" } } }] };
  const selection = { units: [newer, unit], unit_id: unit.unit_id, attempt_id: attempt.id };
  expect(selectPromptView({ ...selection, unit_id: "missing" })).toBeNull();
  expect(selectPromptView({ ...selection, attempt_id: "missing" })).toBeNull();
  expect(selectPromptView(selection)?.template).toEqual({ identifier: attempt.intent.prompt.path, ...attempt.intent.prompt, content: null });
});
it("labels other shared-session tasks as session context rather than selected-attempt provenance", async () => {
  show({ turns: [initial, { turn_id: "later-task" as TurnKey, created_at: "2026-01-02", text: "Later task for another collection member" }] });
  await screen.findByText("Later task for another collection member");
  expect(screen.getByRole("heading", { name: "Session context" })).toBeTruthy();
  expect(screen.getByText(/Shared sessions can include other attempts and later tasks/)).toBeTruthy();
  expect(screen.getByText("pinned-old-digest")).toBeTruthy();
  expect(screen.queryByText("newer-digest")).toBeNull();
});
it("opens the recorded prompt beside the stage overview", () => {
  const onOpen = vi.fn();
  render(<StageOverviewContent runId={unit.run_id} label="Stage" inputs={selectStageInputs({ unit, index: { run_id: unit.run_id, units: [unit], revisions: [] }, artifacts: [] })}
    execution={{ attempts: [], outputs: [], reviews: [], recorded_decisions: [] }} evaluation={{ stages: { state: "pending" }, findings: { state: "pending" }, tasks: { state: "pending" }, statuses: [], links: [] }} artifactState="loaded" onOpenBeside={onOpen} />);
  fireEvent.click(screen.getByRole("button", { name: /Prompt workflow-config/ }));
  expect(onOpen).toHaveBeenCalledWith({ kind: "prompt", unit_id: unit.unit_id, attempt_id: attempt.id });
});
it("round-trips prompt identities through hash and stored pane state", () => {
  const pane = { kind: "prompt" as const, unit_id: "run/unit with /", attempt_id: "action:1/2" };
  expect(readHashRoute(`#${formatRunWorkspaceHash("run", pane)}`)).toEqual({ view: "oakridge", route: { sub: "run", id: "run", pane } });
  const state = { primary: { kind: "overview" as const }, secondary: pane };
  writeStoredRunWorkspace("run", state);
  expect(readStoredRunWorkspace("run")).toEqual(state);
});
