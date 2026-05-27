import { useState, useEffect } from "react";
import { readHashRoute } from "../lib/hash";
import type { HashRoute } from "../lib/hash";

export function useHashRoute(): HashRoute | null {
  const [route, setRoute] = useState<HashRoute | null>(() => readHashRoute());
  useEffect(() => {
    const onHash = () => setRoute(readHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
