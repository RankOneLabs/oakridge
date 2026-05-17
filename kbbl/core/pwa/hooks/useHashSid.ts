import { useState, useEffect } from "react";
import { readHashSid, writeHashSid } from "../lib/hash";

export function useHashSid(): [string | null, (sid: string | null) => void] {
  const [sid, setSid] = useState<string | null>(() => readHashSid());
  useEffect(() => {
    const onHash = () => setSid(readHashSid());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  const navigate = (next: string | null) => {
    writeHashSid(next);
    setSid(next);
  };
  return [sid, navigate];
}
