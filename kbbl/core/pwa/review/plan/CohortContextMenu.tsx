import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

interface Props {
  x: number;
  y: number;
  cohortIndex: number;
  onSplit: (cohortIndex: number) => void;
  onDelete: (cohortIndex: number) => void;
  onMergeStart: (cohortIndex: number) => void;
  onClose: () => void;
}

export function CohortContextMenu({ x, y, cohortIndex, onSplit, onDelete, onMergeStart, onClose }: Props) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="cohort-context-menu"
      style={{ position: "fixed", top: y, left: x, zIndex: 9999 }}
    >
      <button type="button" className="cohort-context-item" onClick={() => { onSplit(cohortIndex); onClose(); }}>
        Split…
      </button>
      <button type="button" className="cohort-context-item" onClick={() => { onMergeStart(cohortIndex); onClose(); }}>
        Merge with…
      </button>
      <button type="button" className="cohort-context-item cohort-context-item--danger" onClick={() => { onDelete(cohortIndex); onClose(); }}>
        Delete
      </button>
    </div>,
    document.body,
  );
}

interface EdgeMenuProps {
  x: number;
  y: number;
  from: number;
  to: number;
  onDelete: (from: number, to: number) => void;
  onClose: () => void;
}

export function EdgeContextMenu({ x, y, from, to, onDelete, onClose }: EdgeMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    function handleClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        onClose();
      }
    }
    document.addEventListener("mousedown", handleClick);
    return () => document.removeEventListener("mousedown", handleClick);
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      className="edge-context-menu"
      style={{ position: "fixed", top: y, left: x, zIndex: 9999 }}
    >
      <button
        type="button"
        className="edge-context-item edge-context-item--danger"
        onClick={() => { onDelete(from, to); onClose(); }}
      >
        Delete edge
      </button>
    </div>,
    document.body,
  );
}
