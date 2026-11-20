import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";

import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq, type PermissionItem,
} from "../../../acp/transcript-model";
import { applyIncrementalFrames } from "../../lib/session-frames";
import { getSessionTranscriptStore, releaseSessionTranscriptStore } from "../../state/session-transcript-store";
import type { TurnKey, UiOpenTurn } from "../../types";
import { SessionTopBar } from "../molecules/SessionTopBar";
import { AgentStatusPanel } from "./AgentStatusPanel";
import { permissionCardAnchorId } from "./PermissionCard";

const { mutateAsync } = vi.hoisted(() => ({ mutateAsync: vi.fn(async () => {}) }));
vi.mock("../../hooks/usePermissionAnswer", () => ({
  usePermissionAnswer: () => ({ mutateAsync, isPending: false }),
}));

const sid = "agent-status-test";
const store = () => getSessionTranscriptStore(sid);
const running: UiOpenTurn = {
  turnKey: "operator:running" as TurnKey, text: "Run a long check against the retained session",
  createdAt: new Date(Date.now() - 30_000).toISOString(), source: "operator", status: "prompting",
};

function permission(index: number): PermissionItem {
  const seq = transcriptSeq(index);
  return {
    kind: "permission", seq, id: transcriptItemId(seq), request_id: permissionRequestId(`request-${index}`),
    title: `Permission ${index}`, options: [{ option_id: "allow", name: `Allow ${index}`, kind: "allow_once" }],
    resolution: null,
  };
}

function renderPanel() {
  return render(
    <AgentStatusPanel
      sid={sid} snapshot={null} pendingSends={[]} isInterrupting={false}
      localWaitStartedMs={null} sessionClosed={false}
    />,
  );
}

afterEach(() => {
  cleanup();
  releaseSessionTranscriptStore(sid);
  mutateAsync.mockClear();
});

it("renders authoritative row values with truncation and matches the top bar context label", () => {
  const usage = { used: 1200, size: 100_000, cost: null };
  store().setState({
    history: { kind: "transcript", expired: false, summary: null, unavailable_reason: null },
    session_state: {
      ...EMPTY_SESSION_LIVE_STATE, active_turn: running.turnKey, usage,
      latest_agent_line: { item_id: transcriptItemId(transcriptSeq(1)), text: "Source read" },
      active_tool: {
        item_id: transcriptItemId(transcriptSeq(2)), tool_call_id: "tool", title: "Read source",
        tool_kind: { is_recognized: true, value: "read" }, status: { is_recognized: true, value: "in_progress" },
      },
      plan_progress: { completed: 1, total: 3, current_entry: "Check output" },
    },
    open_turns: [
      running,
      { ...running, turnKey: "operator:later" as TurnKey, status: "accepted", text: "Later prompt" },
      { ...running, turnKey: "operator:earlier" as TurnKey, status: "accepted", text: "Earlier prompt", createdAt: "2026-01-01" },
    ],
  });
  const { container } = renderPanel();
  const panel = within(screen.getByRole("region", { name: "Agent status" }));
  expect(panel.getByRole("status").textContent).toBe("running");
  expect(container.querySelector(".thinking-meta")?.textContent).toMatch(/30s/);
  expect(panel.getByTitle(running.text).classList.contains("status-row__value")).toBe(true);
  expect(panel.getByText("Source read")).toBeTruthy();
  expect(panel.getByText("Read source · read")).toBeTruthy();
  expect(panel.getByText("1/3 · Check output")).toBeTruthy();
  const queue = panel.getByText("queued").parentElement;
  expect(Array.from(queue?.querySelectorAll("[title]") ?? [], (row) => row.textContent))
    .toEqual(["Earlier prompt", "Later prompt"]);

  render(
    <SessionTopBar
      sid={sid} snapshot={null} chrome={{ kind: "pane", stage: null }}
      streamStatus="connected" inboxStatus="connected" usage={usage}
    />,
  );
  expect(panel.getByText("1k tokens/100k tokens").textContent)
    .toBe(screen.getByTitle("context used").textContent);
});

it("keeps execution visible when all optional rows are absent", () => {
  store().setState({ history: { kind: "transcript", expired: false, summary: null, unavailable_reason: null } });
  const { container } = renderPanel();
  expect(screen.getByRole("status").textContent).toBe("idle");
  expect(container.querySelector(".status-row, .card-permission")).toBeNull();
});

it("answers the chosen request and removes its card after a live state frame", () => {
  const permissions = [permission(1), permission(2)];
  const state = { ...EMPTY_SESSION_LIVE_STATE, open_permissions: permissions };
  store().setState({ session_state: state });
  renderPanel();
  expect(screen.getAllByRole("button")).toHaveLength(2);
  fireEvent.click(screen.getByRole("button", { name: "Allow 1" }));
  expect(mutateAsync).toHaveBeenCalledWith({ requestId: "request-1", optionId: "allow" });

  act(() => store().setState((previous) => applyIncrementalFrames(previous, [
    { kind: "session_state", state: { ...state, open_permissions: permissions.slice(1) } },
  ])));
  expect(document.getElementById(permissionCardAnchorId("request-1"))).toBeNull();
  expect(screen.getByRole("button", { name: "Allow 2" })).toBeTruthy();
});
