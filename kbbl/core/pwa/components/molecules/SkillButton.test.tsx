import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";

import { SkillButton } from "./SkillButton";
import type { Skill } from "../../../runtime-interface";

const CONFIRM_SKILL: Skill = {
  id: "s1",
  name: "deploy",
  description: "",
  backend: "claude-code",
  scope: "user",
  args: [],
  user_invocable: true,
  model_invocable: false,
  confirm: true,
};

const PLAIN_SKILL: Skill = { ...CONFIRM_SKILL, confirm: false };

describe("SkillButton — confirming state", () => {
  it("renders Confirm? affordance when state is confirming", () => {
    render(<SkillButton skill={CONFIRM_SKILL} state="confirming" onTap={() => {}} />);
    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
  });

  it("is not disabled in confirming state", () => {
    render(<SkillButton skill={CONFIRM_SKILL} state="confirming" onTap={() => {}} />);
    expect((screen.getByRole("button") as HTMLButtonElement).disabled).toBe(false);
  });

  it("calls onTap when tapped in confirming state", () => {
    const onTap = vi.fn();
    render(<SkillButton skill={CONFIRM_SKILL} state="confirming" onTap={onTap} />);
    fireEvent.click(screen.getByRole("button"));
    expect(onTap).toHaveBeenCalledOnce();
  });

  it("renders passive confirm affordance in idle state for confirm skill", () => {
    const { container } = render(
      <SkillButton skill={CONFIRM_SKILL} state="idle" onTap={() => {}} />,
    );
    const affordance = container.querySelector(".skill-btn__confirm-affordance");
    expect(affordance).toBeTruthy();
    // passive affordance is aria-hidden, not the active label
    expect(affordance?.getAttribute("aria-hidden")).toBe("true");
  });

  it("does not render confirm affordance for non-confirm skill in idle state", () => {
    const { container } = render(
      <SkillButton skill={PLAIN_SKILL} state="idle" onTap={() => {}} />,
    );
    expect(container.querySelector(".skill-btn__confirm-affordance")).toBeNull();
  });

  it("active affordance replaces passive one in confirming state", () => {
    const { container } = render(
      <SkillButton skill={CONFIRM_SKILL} state="confirming" onTap={() => {}} />,
    );
    const affordance = container.querySelector(".skill-btn__confirm-affordance");
    // active affordance has aria-label, not aria-hidden
    expect(affordance?.getAttribute("aria-label")).toBe("tap to confirm");
    expect(affordance?.getAttribute("aria-hidden")).toBeNull();
  });
});
