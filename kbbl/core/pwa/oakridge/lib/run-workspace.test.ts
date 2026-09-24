import { describe, expect, it } from "vitest";

import type { ArtifactId, Sid } from "../../lib/ids";
import {
  DEFAULT_RUN_WORKSPACE_STATE,
  LIST_PANE,
  OVERVIEW_PANE,
  arePanesEqual,
  closePane,
  collapseToSingle,
  isTwinView,
  openInPane,
  panesOf,
  type RunWorkspacePane,
  type RunWorkspaceState,
} from "./run-workspace";

const sessionPane = (id: string): RunWorkspacePane => ({ kind: "session", session_id: id as Sid });
const artifactPane = (id: string): RunWorkspacePane => ({ kind: "artifact", artifact_id: id as ArtifactId });

const twin = (primary: RunWorkspacePane, secondary: RunWorkspacePane): RunWorkspaceState => ({
  primary,
  secondary,
});

describe("the workspace default", () => {
  it("opens on the overview with no twin", () => {
    expect(DEFAULT_RUN_WORKSPACE_STATE).toEqual({ primary: { kind: "overview" }, secondary: null });
  });
});

describe("openInPane", () => {
  it("opens into an empty secondary without disturbing the primary", () => {
    const state = openInPane(DEFAULT_RUN_WORKSPACE_STATE, "secondary", LIST_PANE);

    expect(state).toEqual({ primary: OVERVIEW_PANE, secondary: LIST_PANE });
  });

  it("replaces a populated secondary", () => {
    const state = openInPane(twin(OVERVIEW_PANE, LIST_PANE), "secondary", artifactPane("art-1"));

    expect(state).toEqual({ primary: OVERVIEW_PANE, secondary: artifactPane("art-1") });
  });

  it("replaces the primary and leaves an unrelated secondary open", () => {
    const state = openInPane(twin(OVERVIEW_PANE, LIST_PANE), "primary", sessionPane("sid-1"));

    expect(state).toEqual({ primary: sessionPane("sid-1"), secondary: LIST_PANE });
  });

  it("collapses rather than showing the same pane in both slots", () => {
    const state = openInPane(twin(OVERVIEW_PANE, LIST_PANE), "primary", LIST_PANE);

    expect(state).toEqual({ primary: LIST_PANE, secondary: null });
  });

  it("ignores opening into the secondary what the primary already shows", () => {
    const before = twin(LIST_PANE, artifactPane("art-1"));

    expect(openInPane(before, "secondary", LIST_PANE)).toBe(before);
  });

  it("distinguishes two sessions as different panes", () => {
    const state = openInPane(twin(sessionPane("sid-1"), LIST_PANE), "secondary", sessionPane("sid-2"));

    expect(state.secondary).toEqual(sessionPane("sid-2"));
  });
});

describe("closePane", () => {
  it("promotes the secondary when the primary closes", () => {
    const state = closePane(twin(OVERVIEW_PANE, sessionPane("sid-1")), "primary");

    expect(state).toEqual({ primary: sessionPane("sid-1"), secondary: null });
  });

  it("falls back to the overview when the only pane closes", () => {
    const state = closePane({ primary: artifactPane("art-1"), secondary: null }, "primary");

    expect(state).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });

  it("closes the secondary and keeps the primary", () => {
    const state = closePane(twin(sessionPane("sid-1"), LIST_PANE), "secondary");

    expect(state).toEqual({ primary: sessionPane("sid-1"), secondary: null });
  });
});

describe("collapseToSingle", () => {
  it("drops the twin and keeps the primary", () => {
    expect(collapseToSingle(twin(OVERVIEW_PANE, LIST_PANE))).toEqual({
      primary: OVERVIEW_PANE,
      secondary: null,
    });
  });

  it("leaves a single-pane workspace alone", () => {
    expect(collapseToSingle(DEFAULT_RUN_WORKSPACE_STATE)).toEqual(DEFAULT_RUN_WORKSPACE_STATE);
  });
});

describe("arePanesEqual", () => {
  it("matches entity panes on their id", () => {
    expect(arePanesEqual(artifactPane("art-1"), artifactPane("art-1"))).toBe(true);
    expect(arePanesEqual(artifactPane("art-1"), artifactPane("art-2"))).toBe(false);
  });

  it("never matches panes of different kinds carrying the same id", () => {
    expect(arePanesEqual(sessionPane("x"), artifactPane("x"))).toBe(false);
  });

  it("treats a closed slot as equal only to another closed slot", () => {
    expect(arePanesEqual(null, null)).toBe(true);
    expect(arePanesEqual(null, OVERVIEW_PANE)).toBe(false);
  });
});

describe("panesOf", () => {
  it("lists the primary alone when there is no twin", () => {
    expect(panesOf(DEFAULT_RUN_WORKSPACE_STATE)).toEqual([OVERVIEW_PANE]);
    expect(isTwinView(DEFAULT_RUN_WORKSPACE_STATE)).toBe(false);
  });

  it("lists both panes primary first in twin view", () => {
    const state = twin(LIST_PANE, OVERVIEW_PANE);

    expect(panesOf(state)).toEqual([LIST_PANE, OVERVIEW_PANE]);
    expect(isTwinView(state)).toBe(true);
  });
});
