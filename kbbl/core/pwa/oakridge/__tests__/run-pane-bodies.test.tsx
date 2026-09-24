import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";

import { RunDetailView } from "../views/RunDetailView";
import { runWorkspaceStorageKey } from "../lib/run-workspace-storage";
import { useStore } from "../../state/store";
import type { Sid } from "../../lib/ids";
import {
  EventSourceStub,
  json,
  makeFetch,
  snapshotOf,
  wrap,
} from "./run-pane-fixtures";

// What the two entity pane bodies do once they host the real renderers. The
// transforms behind them are unit-tested in lib/; what lands here is the
// wiring no transform can cover — that the pane mounts the existing renderer,
// that its chrome loses the route-level affordances, and that two session
// panes are independent of each other.

const renderWorkspace = () =>
  wrap(<RunDetailView runId="run-1" routePane={null} onBack={() => {}} />);

/** Open `sid-c1` in the primary pane the way the operator does. */
const openSessionPane = async () => {
  const rendered = renderWorkspace();
  const rows = await screen.findAllByTestId("or-sidebar-session");
  fireEvent.click(rows[0]!);
  await waitFor(() => expect(screen.getByTestId("or-run-pane-session")).toBeTruthy());
  return rendered;
};

beforeEach(() => {
  // jsdom implements neither Element.scrollTo nor the element scroll geometry
  // the auto-scroll hook reads; the hook's own decision is unit-tested in
  // lib/session-surface.test.ts, so a no-op is enough to let the pane mount.
  Element.prototype.scrollTo = () => {};
  vi.spyOn(globalThis, "fetch").mockImplementation(makeFetch());
  vi.stubGlobal("EventSource", EventSourceStub);
  EventSourceStub.instances = [];
  localStorage.clear();
  useStore.setState({
    sessions: new Map([
      ["sid-c1" as Sid, snapshotOf("sid-c1")],
      ["sid-c2" as Sid, snapshotOf("sid-c2")],
    ]),
    inboxStatus: "connected",
    removedSids: new Set(),
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe("the artifact pane", () => {
  /** Open the run's one artifact and wait for the loaded review, not the spinner. */
  const openArtifactPane = async () => {
    renderWorkspace();
    const rows = await screen.findAllByTestId("or-sidebar-artifact");
    fireEvent.click(rows[0]!);
    await screen.findByTestId("or-artifact-type");
    return screen.getByTestId("or-artifact-detail");
  };

  it("renders the full review experience inside the pane", async () => {
    const detail = await openArtifactPane();

    // Descriptor-driven viewer, review items, threads and the gate decision —
    // the whole ArtifactReview organism, not a pane-local reimplementation.
    expect(detail.getAttribute("data-review-layout")).toBe("report");
    expect(await screen.findByTestId("or-review-items-section")).toBeTruthy();
    expect(screen.getByTestId("or-threads-section")).toBeTruthy();
    expect(await screen.findByTestId("or-artifact-gate-actions")).toBeTruthy();
    expect(screen.getByTestId("or-decision-approve").textContent).toContain("Approve the build");
  });

  it("shows the pane's own chrome instead of a route-level back button", async () => {
    await openArtifactPane();

    expect(screen.queryByText("← Back")).toBeNull();
    expect(screen.getByTestId("or-run-pane-close-primary")).toBeTruthy();
    expect(screen.getByTestId("or-run-pane-move-primary")).toBeTruthy();
  });
});

describe("the session pane", () => {
  it("renders the live transcript inside the pane's own scroll container", async () => {
    await openSessionPane();

    const host = screen.getByTestId("or-run-pane-session");
    expect(host.getAttribute("data-session-id")).toBe("sid-c1");
    expect(host.querySelector(".events")).toBeTruthy();
    expect(EventSourceStub.instances.some((es) => es.url.includes("sid-c1"))).toBe(true);
  });

  it("anchors the input bar to the surface rather than to the viewport", async () => {
    await openSessionPane();

    const host = screen.getByTestId("or-run-pane-session");
    // `.bottom-stack` is viewport-fixed by default and only the embedded scope
    // un-fixes it, so the class on the surface root is what says the bar is
    // inside the pane. Asserted structurally because jsdom loads no stylesheet.
    const surface = host.querySelector(".app");
    expect(surface?.classList.contains("session-surface--embedded")).toBe(true);
    expect(host.querySelector(".bottom-stack")).toBeTruthy();
    expect(document.body.querySelectorAll(".bottom-stack")).toHaveLength(1);
  });

  it("keeps session identity in the top bar and drops back and theme", async () => {
    await openSessionPane();

    const topBar = screen.getByTestId("or-run-pane-session").querySelector(".top-bar");
    expect(topBar?.getAttribute("data-chrome")).toBe("pane");
    expect(topBar?.querySelector(".status")).toBeTruthy();
    expect(topBar?.querySelector(".session-label-name")?.textContent).toBe("session sid-c1");
    expect(topBar?.querySelector(".back-button")).toBeNull();
    expect(topBar?.querySelector(".theme-toggle")).toBeNull();
  });
});

describe("two session panes", () => {
  it("each scroll independently and each show their own input bar", async () => {
    renderWorkspace();
    const rows = await screen.findAllByTestId("or-sidebar-session");
    fireEvent.click(rows[0]!);
    fireEvent.click(await screen.findByLabelText("Open build c2 in the second pane"));

    await waitFor(() => expect(screen.getAllByTestId("or-run-pane-session")).toHaveLength(2));
    const [first, second] = screen.getAllByTestId("or-run-pane-session");

    expect(first!.getAttribute("data-session-id")).toBe("sid-c1");
    expect(second!.getAttribute("data-session-id")).toBe("sid-c2");
    // Own scroll host, own bar — neither pane's bar lives in the other's.
    expect(first!.querySelectorAll(".bottom-stack")).toHaveLength(1);
    expect(second!.querySelectorAll(".bottom-stack")).toHaveLength(1);
    expect(first!.contains(second!)).toBe(false);
  });

  it("send from the second pane under that pane's sid, not the first's", async () => {
    const fetchSpy = vi.mocked(globalThis.fetch);
    renderWorkspace();
    const rows = await screen.findAllByTestId("or-sidebar-session");
    fireEvent.click(rows[0]!);
    fireEvent.click(await screen.findByLabelText("Open build c2 in the second pane"));
    await waitFor(() => expect(screen.getAllByTestId("or-run-pane-session")).toHaveLength(2));

    const second = screen.getAllByTestId("or-run-pane-session")[1]!;
    fireEvent.change(within(second).getByLabelText("message input"), {
      target: { value: "status?" },
    });
    fireEvent.click(within(second).getByText("Send"));

    // The sid reaches `InputBox` down the pane's own `SessionView`, so a send
    // landing on the other pane's session is the failure this guards against.
    await waitFor(() => {
      const send = fetchSpy.mock.calls.find(([input]) => String(input).includes("/input"));
      expect(send).toBeTruthy();
      expect(String(send![0])).toBe("/sessions/sid-c2/input");
      expect(JSON.parse(String(send![1]?.body))).toMatchObject({ text: "status?" });
    });
  });

  it("sits beside an artifact pane without either losing its own chrome", async () => {
    renderWorkspace();
    const sessionRows = await screen.findAllByTestId("or-sidebar-session");
    fireEvent.click(sessionRows[0]!);
    fireEvent.click(await screen.findByLabelText("Open dev.build_result v1 in the second pane"));

    await waitFor(() => expect(screen.getByTestId("or-artifact-detail")).toBeTruthy());
    expect(screen.getByTestId("or-run-pane-session")).toBeTruthy();
    expect(screen.getByTestId("or-run-pane-close-primary")).toBeTruthy();
    expect(screen.getByTestId("or-run-pane-close-secondary")).toBeTruthy();
  });
});

describe("a session purged while a pane holds it", () => {
  it("drops the pane back to the overview and prunes the stored entry", async () => {
    await openSessionPane();
    await waitFor(() =>
      expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).toContain("sid-c1"),
    );

    useStore.setState({ removedSids: new Set(["sid-c1" as Sid]) });

    await waitFor(() => expect(screen.getByTestId("or-run-overview")).toBeTruthy());
    expect(screen.queryByTestId("or-run-pane-session")).toBeNull();
    expect(localStorage.getItem(runWorkspaceStorageKey("run-1"))).not.toContain("sid-c1");
  });
});

describe("resuming an ended session from a pane", () => {
  it("opens the resumed session in that same pane", async () => {
    useStore.setState({
      sessions: new Map([["sid-c1" as Sid, { ...snapshotOf("sid-c1"), status: "ended" }]]),
    });
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input);
      if (url.endsWith("/sessions") && init?.method === "POST") {
        return json(snapshotOf("sid-resumed"));
      }
      return makeFetch()(input, init);
    });

    await openSessionPane();
    fireEvent.click(await screen.findByText("Resume in new session"));

    await waitFor(() =>
      expect(screen.getByTestId("or-run-pane-session").getAttribute("data-session-id")).toBe(
        "sid-resumed",
      ),
    );
  });
});
