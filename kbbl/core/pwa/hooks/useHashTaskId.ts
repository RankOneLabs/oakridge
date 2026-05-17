import { useState, useEffect } from "react";
import { readHashTaskId, writeHashTaskId } from "../lib/hash";

export function useHashTaskId(): [number | null, (taskId: number | null) => void] {
  const [taskId, setTaskId] = useState<number | null>(() => readHashTaskId());
  useEffect(() => {
    const onHash = () => setTaskId(readHashTaskId());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: number | null) => {
    if (next !== null && (!Number.isSafeInteger(next) || next <= 0)) return;
    writeHashTaskId(next);
    setTaskId(next);
  };
  return [taskId, navigate];
}
