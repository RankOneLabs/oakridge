import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen } from "@testing-library/react";

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

    await act(async () => {});
    expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-deploy", args: {} });
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

describe("SkillRail confirm gate — non-confirm skills bypass gate", () => {
  it("plain skill dispatches on first tap (no confirm gate)", async () => {
    setup([PLAIN_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    fireEvent.click(screen.getByRole("button", { name: /list-tasks/ }));

    await act(async () => {});
    expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-list", args: {} });
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
