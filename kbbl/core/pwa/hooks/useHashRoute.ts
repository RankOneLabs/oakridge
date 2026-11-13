import { useState, useEffect } from "react";
import { acceptHashNavigation, readHashRoute } from "../lib/hash";
import type { HashRoute } from "../lib/hash";

export function useHashRoute(): HashRoute | null {
  const [route, setRoute] = useState<HashRoute | null>(() => readHashRoute());
  useEffect(() => {
    const onHash = (event: HashChangeEvent) => {
      if (!acceptHashNavigation()) {
        event.stopImmediatePropagation();
        return;
      }
      setRoute(readHashRoute());
    };
    window.addEventListener("hashchange", onHash);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);
  return route;
}
