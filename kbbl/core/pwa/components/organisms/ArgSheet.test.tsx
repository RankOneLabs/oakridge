import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { ArgSheet } from "./ArgSheet";
import type { Skill } from "../../../runtime-interface";

const SKILL: Skill = {
  id: "s-ship",
  name: "ship",
  description: "",
  backend: "claude-code",
  scope: "user",
  args: [{ key: "env", required: true, hint: "target environment" }],
  user_invocable: true,
  model_invocable: false,
};

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("ArgSheet", () => {
  it("closes on Escape", () => {
    const onCancel = vi.fn();
    render(<ArgSheet skill={SKILL} onSubmit={vi.fn()} onCancel={onCancel} />);

    fireEvent.keyDown(document, { key: "Escape" });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("closes on backdrop click", () => {
    const onCancel = vi.fn();
    const { container } = render(
      <ArgSheet skill={SKILL} onSubmit={vi.fn()} onCancel={onCancel} />,
    );

    fireEvent.click(container.querySelector(".arg-sheet__backdrop")!);

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it("gates submit until required fields are filled", () => {
    const onSubmit = vi.fn();
    render(<ArgSheet skill={SKILL} onSubmit={onSubmit} onCancel={vi.fn()} />);

    const submit = screen.getByRole("button", { name: "Run" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByLabelText(/target environment/), {
      target: { value: "staging" },
    });
    expect((submit as HTMLButtonElement).disabled).toBe(false);
  });

  it("collects MCP integer and boolean arguments with typed controls", () => {
    const onSubmit = vi.fn();
    const mcpSkill: Skill = {
      ...SKILL,
      id: "cc:mcp:gated-review:get_review_round",
      name: "mcp:gated-review:get_review_round",
      args: [
        {
          key: "pullRequestNumber",
          required: true,
          hint: "pull request number",
          kind: "integer",
        },
        {
          key: "includeResolved",
          required: false,
          hint: "include resolved threads",
          kind: "boolean",
        },
      ],
    };
    render(<ArgSheet skill={mcpSkill} onSubmit={onSubmit} onCancel={vi.fn()} />);

    fireEvent.change(screen.getByLabelText(/pull request number/), {
      target: { value: "373" },
    });
    fireEvent.click(screen.getByLabelText(/include resolved threads/));
    fireEvent.click(screen.getByRole("button", { name: "Run" }));

    expect(onSubmit).toHaveBeenCalledWith({
      pullRequestNumber: "373",
      includeResolved: "true",
    });
  });
});
