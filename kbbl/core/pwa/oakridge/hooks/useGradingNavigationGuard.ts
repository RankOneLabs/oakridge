import { useEffect, useRef } from "react";
import { registerHashNavigationGuard } from "../../lib/hash";

/** The router checks this guard before changing the rendered route. */
export function useGradingNavigationGuard(hasUnsavedChanges: boolean): void {
  const currentUrl = useRef(window.location.href);
  useEffect(() => {
    const unregister = registerHashNavigationGuard(() => {
      const nextUrl = window.location.href;
      if (nextUrl === currentUrl.current) return true;
      if (hasUnsavedChanges && !window.confirm("Discard unsaved local edits and open another view?")) {
        window.history.replaceState(window.history.state, "", currentUrl.current);
        return false;
      }
      currentUrl.current = nextUrl;
      return true;
    });
    const onUnload = (event: BeforeUnloadEvent) => {
      if (!hasUnsavedChanges) return;
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", onUnload);
    return () => {
      unregister();
      window.removeEventListener("beforeunload", onUnload);
    };
  }, [hasUnsavedChanges]);
}
