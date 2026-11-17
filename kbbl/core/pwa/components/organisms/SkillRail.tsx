import { quickActionKey, selectQuickActionIcon, selectQuickActions } from "../../lib/quick-actions";
import { useStore } from "../../state/store";
import { Button } from "../atoms/Button";
import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot, UiAvailableCommand } from "../../types";
import type { Skill } from "../../../runtime-interface";
import {
  useSkills,
  useInvokeSkill,
  useInvokeAgentCommand,
} from "../../hooks/useSkills";
import { SkillButton } from "../molecules/SkillButton";
import { ArgSheet } from "./ArgSheet";

interface RailSection {
  key: string;
  label: string;
  isMcp: boolean;
  skills: Skill[];
}

function isMcpSkill(skill: Skill): boolean {
  return skill.id.split(":")[1] === "mcp";
}

function backendLabel(backend: Skill["backend"]): string {
  if (backend === "claude-code") return "Claude Code";
  if (backend === "codex") return "Codex";
  return backend;
}

// MCP tools cluster by server; other actions cluster by backend and scope.
function sectionFor(skill: Skill): { key: string; label: string; isMcp: boolean } {
  if (isMcpSkill(skill)) {
    const server = skill.id.split(":")[2] ?? "mcp";
    return { key: `mcp:${server}`, label: `MCP · ${server}`, isMcp: true };
  }
  const base = backendLabel(skill.backend);
  const label = skill.scope === "user" ? base : `${base} · ${skill.scope}`;
  return { key: `${skill.backend}:${skill.scope}`, label, isMcp: false };
}

// Show the bare MCP tool name under its server header.
function skillLabel(skill: Skill): string {
  if (isMcpSkill(skill)) {
    const parts = skill.name.split(":");
    return parts.length >= 3 ? parts.slice(2).join(":") : skill.name;
  }
  return skill.name;
}

export function SkillRail({
  sid,
  snapshot,
  commands = [],
  position = "bottom",
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  commands?: readonly UiAvailableCommand[];
  position?: "bottom" | "right" | "composer";
}) {
  const skills = useSkills(sid);
  const invokeMutation = useInvokeSkill(sid);
  const commandMutation = useInvokeAgentCommand(sid);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<Skill | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const quickKeys = useStore((state) => state.quickActionKeys);
  const toggleQuickAction = useStore((state) => state.toggleQuickAction);
  const [collapsed, setCollapsed] = useState(true);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  // Missing overrides use the section default: MCP closed, everything else open.
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const isSessionLive =
    snapshot?.status === "idle" || snapshot?.status === "prompting";

  const sections = useMemo(() => {
    const map = new Map<string, RailSection>();
    // Advertised agent commands lead; MCP tools sort last.
    if (commands.length > 0) {
      map.set("agent-commands", {
        key: "agent-commands",
        label: "Agent commands",
        isMcp: false,
        skills: commands.map((command) => ({
          id: `agent-command:${command.name}`,
          name: command.name,
          description: command.description ?? "",
          backend: snapshot?.agentProfile ?? "agent",
          scope: "system",
          args: [],
          user_invocable: true,
          model_invocable: false,
        })),
      });
    }
    for (const skill of skills) {
      const { key, label, isMcp } = sectionFor(skill);
      let section = map.get(key);
      if (!section) {
        section = { key, label, isMcp, skills: [] };
        map.set(key, section);
      }
      section.skills.push(skill);
    }
    return [...map.values()].sort((a, b) =>
      a.isMcp === b.isMcp ? 0 : a.isMcp ? 1 : -1,
    );
  }, [skills, commands, snapshot?.agentProfile]);

  if (skills.length === 0 && commands.length === 0) return null;

  function isSectionOpen(section: RailSection): boolean {
    return sectionOverrides[section.key] ?? !section.isMcp;
  }

  function toggleSection(section: RailSection) {
    setSectionOverrides((prev) => ({
      ...prev,
      [section.key]: !(prev[section.key] ?? !section.isMcp),
    }));
  }

  function getButtonState(skill: Skill) {
    if (!isSessionLive) return "disabled" as const;
    if (dispatchingId === skill.id) return "dispatching" as const;
    if (dispatchingId !== null) return "disabled" as const;
    if (collecting?.id === skill.id) return "collecting" as const;
    if (confirmingId === skill.id) return "confirming" as const;
    return "idle" as const;
  }

  async function dispatch(skill: Skill, args: Record<string, string>) {
    setCollapsed(true);
    setCollecting(null);
    setInvokeError(null);
    setDispatchingId(skill.id);
    try {
      if (skill.id.startsWith("agent-command:")) {
        await commandMutation.mutateAsync(skill.name);
      } else {
        await invokeMutation.mutateAsync({ skill_id: skill.id, args });
      }
    } catch (err) {
      // A failed submission must remain visible even after the rail closes.
      const detail = err instanceof Error ? ` ${err.message}` : "";
      setInvokeError(`Couldn't invoke "${skill.name}".${detail}`);
    } finally {
      setDispatchingId(null);
    }
  }

  function clearConfirming() {
    if (confirmTimerRef.current !== null) {
      clearTimeout(confirmTimerRef.current);
      confirmTimerRef.current = null;
    }
    setConfirmingId(null);
  }

  function handleTap(skill: Skill) {
    if (!isSessionLive || dispatchingId !== null) return;

    // The second tap proceeds to argument collection or dispatch.
    if (confirmingId === skill.id) {
      clearConfirming();
      if (skill.args.length > 0) {
        setCollecting(skill);
      } else {
        void dispatch(skill, {});
      }
      return;
    }

    if (confirmingId !== null) clearConfirming();

    // Preserve the existing confirm timeout and clear any argument sheet.
    if (skill.confirm) {
      setCollecting(null);
      setConfirmingId(skill.id);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmingId(null);
        confirmTimerRef.current = null;
      }, 3000);
      return;
    }

    if (skill.args.length > 0) {
      setCollecting(skill);
    } else {
      void dispatch(skill, {});
    }
  }

  const argSheetSkill = collecting;

  return (
    <>
      <div className={`skill-rail skill-rail--${position}`}>
        <Button variant="session"
          type="button"
          className="skill-rail__toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
          aria-label="Skills"
          title="Skills"
        >
          <span aria-hidden="true">☰</span>
        </Button>
        {invokeError !== null && (
          <div className="skill-rail__error" role="alert">
            <span className="skill-rail__error-text">{invokeError}</span>
            <Button variant="session"
              type="button"
              className="skill-rail__error-dismiss"
              onClick={() => setInvokeError(null)}
              aria-label="dismiss error"
            >
              ×
            </Button>
          </div>
        )}
        {collapsed && selectQuickActions(sections.flatMap((section) => section.skills), quickKeys).map((skill) =>
          <SkillButton key={skill.id} skill={skill} label={skillLabel(skill)} icon={selectQuickActionIcon(skill, skillLabel(skill))}
            state={getButtonState(skill)} onTap={() => handleTap(skill)} />)}
        {!collapsed && (
          <div className="skill-rail__groups">
            {sections.map((section) => {
              const open = isSectionOpen(section);
              return (
                <div key={section.key} className="skill-rail__group">
                  <Button variant="session"
                    type="button"
                    className="skill-rail__group-label"
                    onClick={() => toggleSection(section)}
                    aria-expanded={open}
                  >
                    <span className="skill-rail__group-caret" aria-hidden="true">
                      {open ? "▾" : "▸"}
                    </span>
                    {section.label}
                    <span className="skill-rail__group-count">
                      {section.skills.length}
                    </span>
                  </Button>
                  {open && (
                    <div className="skill-rail__scope">
                      {section.skills.map((skill) => (
                        <span key={skill.id} className="inline-flex items-center">
                        <SkillButton
                          skill={skill}
                          label={skillLabel(skill)}
                          state={getButtonState(skill)}
                          onTap={() => handleTap(skill)}
                        />
                        <Button variant="session" type="button"
                          aria-label={`Quick action: ${skillLabel(skill)}`}
                          aria-pressed={quickKeys.includes(quickActionKey(skill))}
                          onClick={() => toggleQuickAction(quickActionKey(skill))}><span aria-hidden="true">{quickKeys.includes(quickActionKey(skill)) ? "★" : "☆"}</span></Button>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
      {argSheetSkill !== null && (
        <ArgSheet
          skill={argSheetSkill}
          onSubmit={(args) => void dispatch(argSheetSkill, args)}
          onCancel={() => setCollecting(null)}
        />
      )}
    </>
  );
}
