import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";

import { SkillRail } from "./SkillRail";
import type { Skill } from "../../../runtime-interface";
import type { SessionSnapshot } from "../../types";

vi.mock("../../hooks/useSkills");
import { useSkills, useInvokeSkill, useInvokeAgentCommand } from "../../hooks/useSkills";

const LIVE_SNAPSHOT = { status: "idle", agentProfile: "claude-code" } as SessionSnapshot;

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
  args: [{ key: "env", required: true, hint: "target environment", kind: "string" }],
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
  vi.mocked(useInvokeAgentCommand).mockReturnValue({
    mutateAsync: vi.fn().mockResolvedValue(undefined),
    error: null,
  } as unknown as ReturnType<typeof useInvokeAgentCommand>);
}

function renderOpenRail() {
  render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);
  fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)^Skills$/ }));
}

afterEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
});

describe("SkillRail collapsed default", () => {
  it("starts with the skills section closed", () => {
    setup([PLAIN_SKILL]);
    render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} />);

    expect(
      screen
        .getByRole("button", { name: /^(?!Quick action:)^Skills$/ })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(screen.queryByRole("button", { name: /^(?!Quick action:)list-tasks/ })).toBeNull();
  });
});

describe("SkillRail two-tap confirm chain — no args", () => {
  it("first tap on confirm skill enters confirming state (does not dispatch)", () => {
    setup([CONFIRM_SKILL]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)deploy/ }));

    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("second tap on confirming skill (no args) dispatches", async () => {
    setup([CONFIRM_SKILL]);
    renderOpenRail();

    const btn = screen.getByRole("button", { name: /^(?!Quick action:)deploy/ });
    fireEvent.click(btn); // first tap → confirming
    fireEvent.click(btn); // second tap → dispatch

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-deploy", args: {} }),
    );
    expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-expanded")).toBe("false");
  });
});

describe("SkillRail two-tap confirm chain — with args", () => {
  it("first tap on confirm skill with args enters confirming state", () => {
    setup([CONFIRM_SKILL_WITH_ARGS]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)ship/ }));

    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
    expect(mockMutateAsync).not.toHaveBeenCalled();
  });

  it("second tap on confirming skill with args opens ArgSheet, not dispatch", () => {
    setup([CONFIRM_SKILL_WITH_ARGS]);
    renderOpenRail();

    const btn = screen.getByRole("button", { name: /^(?!Quick action:)ship/ });
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
      args: [{ key: "query", required: true, hint: "search query", kind: "string" }],
    };
    setup([PLAIN_WITH_ARGS, CONFIRM_SKILL]);
    renderOpenRail();

    // Open ArgSheet for the plain-with-args skill
    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)search/ }));
    expect(screen.getByRole("dialog")).toBeTruthy();

    // Tap the confirm-gate skill — ArgSheet should close, confirming state entered
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)deploy/ }));
    });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();
  });
});

describe("SkillRail confirm gate — non-confirm skills bypass gate", () => {
  it("plain skill dispatches on first tap (no confirm gate)", async () => {
    setup([PLAIN_SKILL]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)list-tasks/ }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-list", args: {} }),
    );
  });

  it("tapping a different skill cancels in-flight confirm gate", async () => {
    setup([CONFIRM_SKILL, PLAIN_SKILL]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)deploy/ })); // enter confirming
    expect(screen.getByLabelText("tap to confirm")).toBeTruthy();

    // Tap a different skill — confirm gate should clear; dispatch fires async
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)list-tasks/ }));
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
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)list-tasks/ }));

    fireEvent.click(screen.getByRole("button", { name: "Skills" }));
    // Reopening the full set during dispatch keeps every action disabled.
    expect(
      (screen.getByRole("button", { name: /^(?!Quick action:)other-task/ }) as HTMLButtonElement)
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
    renderOpenRail();

    // Non-MCP skill is visible; the MCP tool button is hidden behind its header.
    expect(screen.getByRole("button", { name: /^(?!Quick action:)list-tasks/ })).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^(?!Quick action:)open_pr/ })).toBeNull();
  });

  it("expanding the MCP section reveals the de-prefixed tool name", () => {
    setup([MCP_SKILL]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)MCP · gated-review/ }));

    const toolBtn = screen.getByRole("button", { name: /^(?!Quick action:)open_pr/ });
    expect(toolBtn).toBeTruthy();
    // The verbose mcp:server: prefix is stripped from the visible label.
    expect(toolBtn.textContent).not.toContain("mcp:gated-review:");
  });

  it("dispatches an expanded MCP selection through the skill invoke mutation", async () => {
    setup([MCP_SKILL]);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)MCP · gated-review/ }));
    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)open_pr/ }));

    await waitFor(() =>
      expect(mockMutateAsync).toHaveBeenCalledWith({
        skill_id: "codex:mcp:gated-review:open_pr",
        args: {},
      }),
    );
  });
});

describe("SkillRail invoke failure", () => {
  it("surfaces an error alert when dispatch fails", async () => {
    vi.mocked(useSkills).mockReturnValue([PLAIN_SKILL]);
    vi.mocked(useInvokeSkill).mockReturnValue({
      mutateAsync: vi.fn().mockRejectedValue(new Error("transport down")),
      error: null,
    } as unknown as ReturnType<typeof useInvokeSkill>);
    renderOpenRail();

    fireEvent.click(screen.getByRole("button", { name: /^(?!Quick action:)list-tasks/ }));

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("list-tasks");
  });
});

it("shows only advertised default quick actions beside Skills", () => {
  setup([PLAIN_SKILL, { ...PLAIN_SKILL, id: "cc:mcp:gated-review:get_review_round", name: "mcp:gated-review:get_review_round" }]);
  render(<SkillRail sid="test-sid" snapshot={LIVE_SNAPSHOT} commands={[{ name: "compact", description: "Compact" }]} />);
  expect(screen.getAllByRole("button").map((button) => button.textContent)).toEqual(["Skills", "compactclaude-code", "get_review_roundclaude-code"]);
});

it("persists a selected action and shows it after collapsing", () => {
  setup([PLAIN_SKILL]);
  renderOpenRail();
  fireEvent.click(screen.getByRole("button", { name: "Quick action: list-tasks" }));
  fireEvent.click(screen.getByRole("button", { name: "Skills" }));
  expect(screen.getByRole("button", { name: /^list-tasks/ })).toBeTruthy();
  expect(JSON.parse(localStorage.getItem("kbbl.skillRail.quickActions") ?? "null")).toContain("list-tasks");
});

it("collapses at dispatch start", () => {
  setup([PLAIN_SKILL]);
  renderOpenRail();
  fireEvent.click(screen.getByRole("button", { name: /^list-tasks/ }));
  expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-expanded")).toBe("false");
  expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: PLAIN_SKILL.id, args: {} });
});

it("collapses after ArgSheet submit and preserves invocation arguments", async () => {
  setup([CONFIRM_SKILL_WITH_ARGS]);
  renderOpenRail();
  const button = screen.getByRole("button", { name: /^(?!Quick action:)ship/ });
  fireEvent.click(button);
  fireEvent.click(button);
  fireEvent.change(screen.getByRole("textbox"), { target: { value: "production" } });
  fireEvent.click(screen.getByRole("button", { name: "Run" }));
  expect(screen.getByRole("button", { name: "Skills" }).getAttribute("aria-expanded")).toBe("false");
  await waitFor(() => expect(mockMutateAsync).toHaveBeenCalledWith({ skill_id: "s-ship", args: { env: "production" } }));
});
