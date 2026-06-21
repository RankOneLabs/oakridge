import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SkillRail } from "./SkillRail";
import type { Skill } from "../../../runtime-interface";
import type { SessionSnapshot } from "../../../session/types";

vi.mock("../../hooks/useSkills");
import { useSkills, useInvokeSkill } from "../../hooks/useSkills";

const LIVE_SNAPSHOT = { status: "live" } as SessionSnapshot;

const CONFIRM_SKILL: Skill = {
  id: "s-deploy",
  name: "deploy",
  description: "",
  backend: "claude-code",
  scope: "user",
  args: [],
  user_invocable: true,
  model_invocable: false,
  confirm: true,
};

const CONFIRM_SKILL_WITH_ARGS: Skill = {
  id: "s-ship",
  name: "ship",
  description: "",
  backend: "claude-code",
  scope: "user",
  args: [{ key: "env", required: true, hint: "target environment" }],
  user_invocable: true,
  model_invocable: false,
  confirm: true,
};

const PLAIN_SKILL: Skill = {
  id: "s-list",
  name: "list-tasks",
  description: "",
  backend: "claude-code",
  scope: "user",
  args: [],
  user_invocable: true,
  model_invocable: true,
  confirm: false,
};

const mockMutateAsync = vi.fn().mockResolvedValue(undefined);

function setup(skills: Skill[]) {
  vi.mocked(useSkills).mockReturnValue(skills);
  vi.mocked(useInvokeSkill).mockReturnValue({
    mutateAsync: mockMutateAsync,
    error: null,
  } as unknown as ReturnType<typeof useInvokeSkill>);
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("SkillRail two-tap confirm chain — no args", () => {
  it("first tap on confirm skill enters confirming state (does not dispatch)", () => {
    setup([CONFIRM_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /deploy/ }));

    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("second tap on confirming skill (no args) dispatches", async () => {
    setup([CONFIRM_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    const btn = screen.getByRole("button", { name: /deploy/ });
    fireEvent.click(btn); // first tap → confirming
    fireEvent.click(btn); // second tap → dispatch

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-deploy", args: {} }),
    );
  });
});

describe("SkillRail two-tap confirm chain — with args", () => {
  it("first tap on confirm skill with args enters confirming state", () => {
    setup([CONFIRM_SKILL_WITH_ARGS]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /ship/ }));

    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("second tap on confirming skill with args opens ArgSheet, not dispatch", () => {
    setup([CONFIRM_SKILL_WITH_ARGS]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    const btn = screen.getByRole("button", { name: /ship/ });
    fireEvent.click(btn); // first tap → confirming
    fireEvent.click(btn); // second tap → collect (ArgSheet)

    expect(mockMutateAsync).not.toHaveBeenCalled();
    // ArgSheet renders a dialog with the skill name as title
    expect(screen.getByRole("dialog")).toBeTruthy();
  });
});

describe("SkillRail confirm gate — ArgSheet cleared on gate entry", () => {
  it("closes open ArgSheet when a confirm-gate skill is tapped", async () => {
    // PLAIN_SKILL_WITH_ARGS opens ArgSheet on first tap (no confirm gate)
    const PLAIN_WITH_ARGS: Skill = {
      ...PLAIN_SKILL,
      id: "s-plain-args",
      name: "search",
      args: [{ key: "query", required: true, hint: "search query" }],
    };
    setup([PLAIN_WITH_ARGS, CONFIRM_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    // Open ArgSheet for the plain-with-args skill
    fireEvent.click(screen.getByRole("button", { name: /search/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Tap the confirm-gate skill — ArgSheet should close, confirming state entered
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /deploy/ }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
  });
});

describe("SkillRail confirm gate — non-confirm skills bypass gate", () => {
  it("plain skill dispatches on first tap (no confirm gate)", async () => {
    setup([PLAIN_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /list-tasks/ }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-list", args: {} }),
    );
  });

  it("tapping a different skill cancels in-flight confirm gate", async () => {
    setup([CONFIRM_SKILL, PLAIN_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /deploy/ })); // enter confirming
    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();

    // Tap a different skill — confirm gate should clear; dispatch fires async
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /list-tasks/ }));
    });
    expect(screen.queryByLabelText("tap to confirm")).toBeNull();
  });
});

describe("SkillRail dispatch in-flight", () => {
  it("disables other buttons while a dispatch is pending", () => {
    const PLAIN_B: Skill = { ...PLAIN_SKILL, id: "s-other", name: "other-task" };
    vi.mocked(useSkills).mockReturnValue([PLAIN_SKILL, PLAIN_B]);
    vi.mocked(useInvokeSkill).mockReturnValue({
      mutateAsync: vi.fn().mockReturnValue(new Promise(() => {})), // never resolves
      error: null,
    } as unknown as ReturnType<typeof useInvokeSkill>);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /list-tasks/ }));

    // The tapped button is dispatching (disabled); the sibling is now disabled too.
    expect(
      (screen.getByRole("button", { name: /other-task/ }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});

describe("SkillRail MCP grouping + collapse", () => {
  const MCP_SKILL: Skill = {
    id: "codex:mcp:gated-review:open_pr",
    name: "mcp:gated-review:open_pr",
    description: "Open a PR",
    backend: "codex",
    scope: "system",
    args: [],
    user_invocable: true,
    model_invocable: true,
  };

  it("MCP tool sections are collapsed by default", () => {
    setup([PLAIN_SKILL, MCP_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    // Non-MCP skill is visible; the MCP tool button is hidden behind its header.
    expect(screen.getByRole("button", { name: /list-tasks/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /open_pr/ })).toBeNull();
  });

  it("expanding the MCP section reveals the de-prefixed tool name", () => {
    setup([MCP_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /MCP · gated-review/ }));

    const toolBtn = screen.getByRole("button", { name: /open_pr/ });
    expect(toolBtn).toBeTruthy();
    // The verbose mcp:server: prefix is stripped from the visible label.
    expect(toolBtn.textContent).not.toContain("mcp:gated-review:");
  });
});

describe("SkillRail invoke failure", () => {
  it("surfaces an error alert when dispatch fails", async () => {
    vi.mocked(useSkills).mockReturnValue([PLAIN_SKILL]);
    vi.mocked(useInvokeSkill).mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new Error("transport down")),
      error: null,
    } as unknown as ReturnType<typeof useInvokeSkill>);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /list-tasks/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("list-tasks");
  });
});
