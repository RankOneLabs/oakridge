import { useEffect, useMemo, useRef, useState } from "react";
import type { SessionSnapshot } from "../../types";
import type { Skill } from "../../../runtime-interface";
import { useSkills, useInvokeSkill } from "../../hooks/useSkills";
import { SkillButton } from "../molecules/SkillButton";
import { ArgSheet } from "./ArgSheet";

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
  const [collapsed, setCollapsed] = useState(false);
  const [invokeError, setInvokeError] = useState<string | null>(null);

  useEffect(() => {
    return () => {
      if (confirmTimerRef.current !== null) clearTimeout(confirmTimerRef.current);
    };
  }, []);

  const isSessionLive = snapshot?.status === "live";

  const grouped = useMemo(() => {
    const map = new Map<string, Map<string, Skill[]>>();
    for (const skill of skills) {
      let byScope = map.get(skill.backend);
      if (!byScope) {
        byScope = new Map();
        map.set(skill.backend, byScope);
      }
      let list = byScope.get(skill.scope);
      if (!list) {
        list = [];
        byScope.set(skill.scope, list);
      }
      list.push(skill);
    }
    return map;
  }, [skills]);

  if (skills.length === 0) return null;

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
            {[...grouped.entries()].map(([backend, byScope]) => (
              <div key={backend} className="skill-rail__group">
                <span className="skill-rail__group-label">{backend}</span>
                {[...byScope.entries()].map(([scope, scopeSkills]) => (
                  <div key={scope} className="skill-rail__scope">
                    {scopeSkills.map((skill) => (
                      <SkillButton
                        key={skill.id}
                        skill={skill}
                        state={getButtonState(skill)}
                        onTap={() => handleTap(skill)}
                      />
                    ))}
                  </div>
                ))}
              </div>
            ))}
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
