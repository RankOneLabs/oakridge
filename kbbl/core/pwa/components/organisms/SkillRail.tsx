import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot } from "../../types";
import type { Skill } from "../../../runtime-interface";
import { useSkills, useInvokeSkill } from "../../hooks/useSkills";
import { SkillButton } from "../molecules/SkillButton";
import { ArgSheet } from "./ArgSheet";

interface RailSection {
  key: string;
  label: string;
  /** MCP-tool sections are collapsed by default so they never crowd the rail. */
  isMcp: boolean;
  skills: Skill[];
}

/** True for an MCP-tool pseudo-skill (id shape `<backend>:mcp:<server>:<tool>`). */
function isMcpSkill(skill: Skill): boolean {
  return skill.id.split(":")[1] === "mcp";
}

function backendLabel(backend: Skill["backend"]): string {
  return backend === "claude-code" ? "Claude Code" : "Codex";
}

/**
 * Group a skill into a rail section. MCP tools cluster per server under their own
 * "MCP · <server>" header; everything else clusters by backend + scope.
 */
function sectionFor(skill: Skill): { key: string; label: string; isMcp: boolean } {
  if (isMcpSkill(skill)) {
    const server = skill.id.split(":")[2] ?? "mcp";
    return { key: `mcp:${server}`, label: `MCP · ${server}`, isMcp: true };
  }
  const base = backendLabel(skill.backend);
  const label = skill.scope === "user" ? base : `${base} · ${skill.scope}`;
  return { key: `${skill.backend}:${skill.scope}`, label, isMcp: false };
}

/**
 * Button label. MCP tools carry a verbose `mcp:<server>:<tool>` name; under the
 * per-server header only the bare tool name is meaningful.
 */
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
  position = "bottom",
}: {
  sid: string;
  snapshot: SessionSnapshot | null;
  position?: "bottom" | "right";
}) {
  const skills = useSkills(sid);
  const invokeMutation = useInvokeSkill(sid);
  const [dispatchingId, setDispatchingId] = useState<string | null>(null);
  const [collecting, setCollecting] = useState<Skill | null>(null);
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const confirmTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [collapsed, setCollapsed] = useState(true);
  const [invokeError, setInvokeError] = useState<string | null>(null);
  // Per-section open/closed overrides keyed by section key. Absent → use the
  // section's default (MCP collapsed, everything else expanded).
  const [sectionOverrides, setSectionOverrides] = useState<Record<string, boolean>>({});

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const isSessionLive = snapshot?.status === "live";

  const sections = useMemo(() => {
    const map = new Map<string, RailSection>();
    for (const skill of skills) {
      const { key, label, isMcp } = sectionFor(skill);
      let section = map.get(key);
      if (!section) {
        section = { key, label, isMcp, skills: [] };
        map.set(key, section);
      }
      section.skills.push(skill);
    }
    // Real skills first, MCP tool sections last so they never lead the rail.
    return [...map.values()].sort((a, b) =>
      a.isMcp === b.isMcp ? 0 : a.isMcp ? 1 : -1,
    );
  }, [skills]);

  if (skills.length === 0) return null;

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
    // A dispatch in-flight blocks taps on every button (see handleTap), so the
    // other buttons must look disabled rather than enabled-but-inert.
    if (dispatchingId !== null) return "disabled" as const;
    if (collecting?.id === skill.id) return "collecting" as const;
    if (confirmingId === skill.id) return "confirming" as const;
    return "idle" as const;
  }

  async function dispatch(skill: Skill, args: Record<string, string>) {
    setCollecting(null);
    setInvokeError(null);
    setDispatchingId(skill.id);
    try {
      await invokeMutation.mutateAsync({ skill_id: skill.id, args });
    } catch {
      // Submission failed (transport down, session not live, …). Surface it
      // explicitly so the user can tell "not dispatched" from "dispatched".
      setInvokeError(`Couldn't invoke "${skill.name}" — it was not submitted.`);
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

    if (confirmingId === skill.id) {
      // Second tap: clear gate and proceed — confirm → collect or dispatch
      clearConfirming();
      if (skill.args.length > 0) {
        setCollecting(skill);
      } else {
        void dispatch(skill, {});
      }
      return;
    }

    // Tapping a different skill cancels any in-flight confirm gate
    if (confirmingId !== null) clearConfirming();

    if (skill.confirm) {
      // First tap on a confirm-gate skill: enter confirming state with timeout revert.
      // Clear any open ArgSheet so collecting and confirming can't be set simultaneously.
      setCollecting(null);
      setConfirmingId(skill.id);
      confirmTimerRef.current = setTimeout(() => {
        setConfirmingId(null);
        confirmTimerRef.current = null;
      }, 3000);
      return;
    }

    // Normal skill: collect args or dispatch directly
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
        <button
          type="button"
          className="skill-rail__toggle"
          onClick={() => setCollapsed((c) => !c)}
          aria-expanded={!collapsed}
        >
          Skills
        </button>
        {invokeError !== null && (
          <div className="skill-rail__error" role="alert">
            <span className="skill-rail__error-text">{invokeError}</span>
            <button
              type="button"
              className="skill-rail__error-dismiss"
              onClick={() => setInvokeError(null)}
              aria-label="dismiss error"
            >
              ×
            </button>
          </div>
        )}
        {!collapsed && (
          <div className="skill-rail__groups">
            {sections.map((section) => {
              const open = isSectionOpen(section);
              return (
                <div key={section.key} className="skill-rail__group">
                  <button
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
                  </button>
                  {open && (
                    <div className="skill-rail__scope">
                      {section.skills.map((skill) => (
                        <SkillButton
                          key={skill.id}
                          skill={skill}
                          label={skillLabel(skill)}
                          state={getButtonState(skill)}
                          onTap={() => handleTap(skill)}
                        />
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
