import { useState, useEffect } from "react";
import { readHashRoute } from "../lib/hash";

export function useHashRoute(): { view: "plan" | "brief"; id: string } | null {
  const [route, setRoute] = useState<{ view: "plan" | "brief"; id: string } | null>(
    () => readHashRoute(),
  );
  useEffect(() => {
    const onHash = () => setRoute(readHashRoute());
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
