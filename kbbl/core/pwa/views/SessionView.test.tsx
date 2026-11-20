import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq, TOOL_STATUSES, type PermissionItem, type PlanItem, type TranscriptItem, type ToolCallItem,
} from "../../acp/transcript-model";
import { permissionCardAnchorId } from "../components/organisms/PermissionCard";
import type { SessionSurfaceLayout } from "../lib/session-surface";
import { getSessionTranscriptStore, releaseSessionTranscriptStore } from "../state/session-transcript-store";
import { useSessionThreadRuntime } from "../hooks/useSessionThreadRuntime";
import { useSendInput } from "../hooks/useSendInput";
import { InputBox } from "../components/organisms/InputBox";
import type { TurnKey } from "../types";
import { SessionView } from "./SessionView";

vi.mock("../lib/session-transcript-connection", () => ({
  acquireSessionTranscript: () => ({ release: () => {} }),
}));

const sid = "conversation-session";
const otherSid = "different-session";
const storedKey = "kbbl.session.threadExpanded.conversation-session";

function sessionView(sessionId: string, layout?: SessionSurfaceLayout) {
  return (
    <SessionView sid={sessionId} snapshot={null} inboxStatus="connected"
      chrome={{ kind: "pane", stage: null }} onResume={async () => null} layout={layout} />
  );
}

function renderView(sessionId: string, layout?: SessionSurfaceLayout) {
  const client = new QueryClient();
  return render(sessionView(sessionId, layout), {
    wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>,
  });
}

beforeEach(() => {
  vi.spyOn(window, "scrollTo").mockImplementation(() => {});
});

afterEach(() => {
  cleanup();
  releaseSessionTranscriptStore(sid);
  releaseSessionTranscriptStore(otherSid);
  localStorage.removeItem(storedKey);
  vi.restoreAllMocks();
});

it("mounts the conversation only when expanded and restores the preference for the same session", () => {
  const { container, unmount } = renderView(sid);
  const panel = screen.getByRole("region", { name: "Agent status" });
  const toggle = screen.getByRole("button", { name: "Show conversation" });
  expect(panel.nextElementSibling).toBe(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(container.querySelector(".events")).toBeNull();

  fireEvent.click(toggle);
  expect(toggle.getAttribute("aria-expanded")).toBe("true");
  expect(localStorage.getItem(storedKey)).toBe("1");
  const timeline = container.querySelector(".events");
  expect(timeline).toBeTruthy();
  expect(timeline?.querySelector(".thinking-indicator")).toBeNull();
  unmount();

  const reopened = renderView(sid);
  expect(screen.getByRole("button", { name: "Hide conversation" })).toBeTruthy();
  expect(reopened.container.querySelector(".events")).toBeTruthy();
  reopened.rerender(sessionView(otherSid));
  expect(screen.getByRole("button", { name: "Show conversation" })).toBeTruthy();
  expect(reopened.container.querySelector(".events")).toBeNull();
  reopened.rerender(sessionView(sid));
  fireEvent.click(screen.getByRole("button", { name: "Hide conversation" }));
  expect(localStorage.getItem(storedKey)).toBe("0");
  expect(reopened.container.querySelector(".events")).toBeNull();
});

it.each(["document", "element"] as const)("uses the thread viewport in the %s layout", (host) => {
  const element = document.createElement("div");
  element.scrollTo = vi.fn();
  const layout: SessionSurfaceLayout | undefined = host === "element"
    ? { barAnchor: "surface", scrollHost: { kind: "element", container: { current: element } } }
    : undefined;
  const { container } = renderView(sid, layout);

  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  expect(container.querySelector(".session-thread > .session-thread__viewport")).toBeTruthy();
  expect(window.scrollTo).not.toHaveBeenCalled();
  expect(element.scrollTo).not.toHaveBeenCalled();
});

it("keeps the panel permission anchor unique when the conversation opens and answers from the thread", async () => {
  const seq = transcriptSeq(1);
  const permission: PermissionItem = {
    kind: "permission", seq, id: transcriptItemId(seq), request_id: permissionRequestId("request"),
    title: "Approve the operation", options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    resolution: null,
  };
  getSessionTranscriptStore(sid).setState({
    session_state: { ...EMPTY_SESSION_LIVE_STATE, open_permissions: [permission] },
    ordered_ids: [permission.id],
    items_by_id: new Map([[permission.id, permission]]),
  });

  const { container } = renderView(sid);
  const anchorId = permissionCardAnchorId(permission.request_id);
  const panelCard = document.getElementById(anchorId);
  expect(panelCard?.closest(".agent-status-panel")).toBeTruthy();
  expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(1);

  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  expect(screen.getAllByRole("button", { name: "Allow" })).toHaveLength(2);
  expect(container.querySelectorAll(`#${anchorId}`)).toHaveLength(1);
  expect(document.getElementById(anchorId)).toBe(panelCard);
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
  const viewport = container.querySelector<HTMLElement>(".session-thread__viewport");
  if (!viewport) throw new Error("missing thread viewport");
  fireEvent.click(within(viewport).getByRole("button", { name: "Allow" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(
    `/sessions/${sid}/permissions/request`, expect.objectContaining({ method: "POST", body: '{"option_id":"allow"}' }),
  ));
});

function setThreadItems(items: TranscriptItem[]) {
  getSessionTranscriptStore(sid).setState({
    ordered_ids: items.map((item) => item.id),
    items_by_id: new Map(items.map((item) => [item.id, item])),
  });
}

it("renders live permissions and plans outside the window and drops stale unanswered permission rows", () => {
  const permissionSeq = transcriptSeq(1);
  const planSeq = transcriptSeq(2);
  const messageSeq = transcriptSeq(3);
  const permission: PermissionItem = {
    kind: "permission", seq: permissionSeq, id: transcriptItemId(permissionSeq),
    request_id: permissionRequestId("live-only"), title: "Live permission",
    options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }], resolution: null,
  };
  const plan: PlanItem = {
    kind: "plan", seq: planSeq, id: transcriptItemId(planSeq),
    entries: [{ content: "Live plan step", status: { is_recognized: true, value: "pending" },
      priority: { is_recognized: true, value: "medium" } }],
  };
  const message: TranscriptItem = {
    kind: "agent_message", id: transcriptItemId(messageSeq), seq: messageSeq, message_id: null,
    text: "Loaded conversation", is_streaming: false, is_replayed: false,
  };
  const store = getSessionTranscriptStore(sid);
  setThreadItems([message]);
  store.setState({ session_state: { ...EMPTY_SESSION_LIVE_STATE, open_permissions: [permission], latest_plan: plan } });

  const { container } = renderView(sid);
  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  const viewport = container.querySelector<HTMLElement>(".session-thread__viewport");
  if (!viewport) throw new Error("missing thread viewport");
  const rowIds = () => Array.from(viewport.querySelectorAll<HTMLElement>("[data-item-id]"), (row) => row.dataset.itemId);
  expect(rowIds()).toEqual([permission.id, plan.id, message.id]);
  expect(within(viewport).getByRole("button", { name: "Allow" })).toBeTruthy();
  expect(within(viewport).getByText("Live plan step")).toBeTruthy();

  act(() => setThreadItems([permission, message]));
  act(() => store.setState({ session_state: { ...EMPTY_SESSION_LIVE_STATE, latest_plan: plan } }));
  expect(rowIds()).toEqual([plan.id, message.id]);
  expect(within(viewport).queryByRole("button", { name: "Allow" })).toBeNull();
});

it("renders sanitized agent Markdown and an expandable thought in the thread", () => {
  const agentSeq = transcriptSeq(1);
  const thoughtSeq = transcriptSeq(2);
  const message = { message_id: null, is_replayed: false, is_streaming: false };
  setThreadItems([
    { ...message, kind: "agent_message", id: transcriptItemId(agentSeq), seq: agentSeq,
      text: "## Rendered heading\n\n<script>forbidden()</script>" },
    { ...message, kind: "thought", id: transcriptItemId(thoughtSeq), seq: thoughtSeq, text: "Consider the next step" },
  ]);
  const { container } = renderView(sid);
  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  expect(screen.getByRole("heading", { name: "Rendered heading" })).toBeTruthy();
  expect(container.querySelector("script")).toBeNull();
  expect(screen.getByText("Consider the next step").closest("details")?.querySelector("summary")?.textContent).toBe("thinking");
});

it("updates the thread tool status from live items and displays all typed content", () => {
  const seq = transcriptSeq(1);
  const tool: ToolCallItem = {
    kind: "tool_call", seq, id: transcriptItemId(seq), tool_call_id: "call", title: "Inspect changes",
    tool_kind: { is_recognized: true, value: "read" }, status: { is_recognized: true, value: "pending" },
    content: [
      { type: "text", text: "Output from the tool" },
      { type: "diff", path: "example.ts", old_text: null, new_text: "updated" },
      { type: "terminal", terminal_id: "terminal-1" },
      { type: "unsupported", acp_type: "custom-value" },
    ],
    locations: [{ path: "example.ts", line: 3 }],
  };
  setThreadItems([tool]);
  const { container } = renderView(sid);
  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  const row = container.querySelector<HTMLElement>("[data-item-id]");
  if (!row) throw new Error("missing tool row");
  for (const value of TOOL_STATUSES) {
    act(() => setThreadItems([{ ...tool, status: { is_recognized: true, value } }]));
    expect(within(row).getByText(value, { exact: true })).toBeTruthy();
  }
  act(() => setThreadItems([{ ...tool, status: { is_recognized: false, raw: "deferred" } }]));
  expect(within(row).getByText("deferred")).toBeTruthy();
  expect(within(row).getByText("example.ts:3")).toBeTruthy();
  expect(JSON.parse(row.querySelector(".card-body")?.textContent ?? "null")).toEqual(tool.content);
});

it("renders distinct snapshots when two transcript items share a tool call ID", () => {
  const originalSeq = transcriptSeq(1);
  const reusedSeq = transcriptSeq(2);
  const original: ToolCallItem = {
    kind: "tool_call", seq: originalSeq, id: transcriptItemId(originalSeq), tool_call_id: "reused",
    title: "First tool run", tool_kind: { is_recognized: true, value: "read" },
    status: { is_recognized: true, value: "completed" }, content: [], locations: [],
  };
  const reused: ToolCallItem = {
    ...original, seq: reusedSeq, id: transcriptItemId(reusedSeq), title: "Second tool run",
    status: { is_recognized: true, value: "in_progress" },
  };
  setThreadItems([original, reused]);
  const { container } = renderView(sid);
  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  const originalRow = container.querySelector<HTMLElement>(`[data-item-id="${original.id}"]`);
  const reusedRow = container.querySelector<HTMLElement>(`[data-item-id="${reused.id}"]`);
  if (!originalRow || !reusedRow) throw new Error("missing tool rows");
  expect(within(originalRow).getByText("First tool run")).toBeTruthy();
  expect(within(originalRow).getByText("completed")).toBeTruthy();
  expect(within(reusedRow).getByText("Second tool run")).toBeTruthy();
  expect(within(reusedRow).getByText("in_progress")).toBeTruthy();
});

function renderInput() {
  const callbacks = { onSend: vi.fn(), onSendAccepted: vi.fn(), onSendFailed: vi.fn() };
  render(<QueryClientProvider client={new QueryClient()}>
    <InputBox sid={sid} {...callbacks} isTurnActive />
  </QueryClientProvider>);
  const input = screen.getByRole<HTMLInputElement>("textbox", { name: "message input" });
  function send(text: string) {
    fireEvent.change(input, { target: { value: text } });
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
  }
  return { input, send, callbacks };
}

it("restores rejected input and retains an uncertain send", async () => {
  vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ error: "input rejected" }, { status: 409 }))
    .mockRejectedValueOnce(new Error("network dropped"));
  const { input, send, callbacks } = renderInput();

  send("try again");
  await screen.findByText("error: input rejected");
  expect(input.value).toBe("try again");
  expect(callbacks.onSendFailed).toHaveBeenCalledWith(callbacks.onSend.mock.calls[0][1]);

  send("network test");
  await screen.findByText("error: network dropped — delivery status unknown, check the transcript before retrying");
  expect(input.value).toBe("");
  expect(callbacks.onSendFailed).toHaveBeenCalledOnce();
});

it("posts the input receipt and interrupts through the existing cancel route", async () => {
  const fetch = vi.spyOn(globalThis, "fetch")
    .mockResolvedValueOnce(Response.json({ turn_key: "turn-1", status: "accepted" }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const { send, callbacks } = renderInput();

  send("send this");
  await waitFor(() => expect(callbacks.onSendAccepted).toHaveBeenCalledWith(expect.any(String), {
    turnKey: "turn-1" as TurnKey, status: "accepted",
  }));
  const clientMessageId = callbacks.onSend.mock.calls[0][1];
  expect(fetch).toHaveBeenCalledWith(`/sessions/${sid}/input`, expect.objectContaining({
    method: "POST", body: JSON.stringify({ text: "send this", client_message_id: clientMessageId }),
  }));

  fireEvent.click(screen.getByRole("button", { name: "Interrupt current turn" }));
  await waitFor(() => expect(fetch).toHaveBeenCalledWith(`/sessions/${sid}/cancel`, { method: "POST" }));
});

it("reflects the active turn in the runtime and sends joined text through useSendInput", async () => {
  const fetch = vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ turn_key: "receipt", status: "accepted" }));
  const callbacks = { onSend: vi.fn(), onSendAccepted: vi.fn(), onSendFailed: vi.fn() };
  const client = new QueryClient();
  const { result } = renderHook(() => {
    const { send } = useSendInput(sid, callbacks);
    return useSessionThreadRuntime(sid, send);
  }, { wrapper: ({ children }) => <QueryClientProvider client={client}>{children}</QueryClientProvider> });

  expect(result.current.thread.getState().isRunning).toBe(false);
  act(() => getSessionTranscriptStore(sid).setState({
    session_state: { ...EMPTY_SESSION_LIVE_STATE, active_turn: "turn" as TurnKey },
  }));
  expect(result.current.thread.getState().isRunning).toBe(true);
  act(() => getSessionTranscriptStore(sid).setState({ session_state: EMPTY_SESSION_LIVE_STATE }));
  expect(result.current.thread.getState().isRunning).toBe(false);

  act(() => result.current.thread.append({
    role: "user", content: [{ type: "text", text: "hello " }, { type: "text", text: "world" }],
  }));
  await waitFor(() => expect(callbacks.onSendAccepted).toHaveBeenCalledOnce());
  expect(callbacks.onSend).toHaveBeenCalledWith("hello world", expect.any(String));
  expect(fetch.mock.calls[0][0]).toBe(`/sessions/${sid}/input`);
});
