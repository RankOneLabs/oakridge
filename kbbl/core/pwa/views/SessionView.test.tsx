import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";

import {
  EMPTY_SESSION_LIVE_STATE, permissionRequestId, transcriptItemId, transcriptSeq, type PermissionItem,
} from "../../acp/transcript-model";
import { permissionCardAnchorId } from "../components/organisms/PermissionCard";
import type { SessionSurfaceLayout } from "../lib/session-surface";
import { getSessionTranscriptStore, releaseSessionTranscriptStore } from "../state/session-transcript-store";
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

it.each(["document", "element"] as const)("scrolls the %s host after mounting the conversation", (host) => {
  const scrollHeight = 8000;
  const element = document.createElement("div");
  const elementScroll = vi.fn();
  element.scrollTo = elementScroll;
  const layout: SessionSurfaceLayout | undefined = host === "element"
    ? { barAnchor: "surface", scrollHost: { kind: "element", container: { current: element } } }
    : undefined;
  const windowScroll = vi.mocked(window.scrollTo);
  const scroll = host === "element" ? elementScroll : windowScroll;
  const otherScroll = host === "element" ? windowScroll : elementScroll;
  const scrollSurface = host === "element" ? element : document.documentElement;
  vi.spyOn(scrollSurface, "scrollHeight", "get").mockImplementation(() => (
    document.querySelector(".events") ? scrollHeight : 100
  ));

  renderView(sid, layout);
  const store = getSessionTranscriptStore(sid);
  act(() => {
    store.setState((state) => ({
      connection: { status: "connected", stream_error: null },
      history: { kind: "transcript", expired: false, summary: null, unavailable_reason: null },
      transcript_version: state.transcript_version + 1,
    }));
  });
  expect(screen.getByText("idle")).toBeTruthy();
  expect(scroll).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Show conversation" }));
  expect(scroll).toHaveBeenCalledWith({ top: scrollHeight });
  expect(otherScroll).not.toHaveBeenCalled();
});

it("keeps the panel permission anchor unique when the conversation opens", () => {
  const seq = transcriptSeq(1);
  const permission: PermissionItem = {
    kind: "permission", seq, id: transcriptItemId(seq), request_id: permissionRequestId("request"),
    title: "Approve the operation", options: [{ option_id: "allow", name: "Allow", kind: "allow_once" }],
    resolution: null,
  };
  getSessionTranscriptStore(sid).setState({
    session_state: { ...EMPTY_SESSION_LIVE_STATE, open_permissions: [permission] },
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
});
