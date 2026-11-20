import { useLayoutEffect, type RefObject } from "react";

interface BarLayoutRefs {
  appRef: RefObject<HTMLDivElement | null>;
  topBarRef: RefObject<HTMLElement | null>;
  bottomBarRef: RefObject<HTMLDivElement | null>;
}

export function useAutoScrollAndLayout({ appRef, topBarRef, bottomBarRef }: BarLayoutRefs): void {
  useLayoutEffect(() => {
    const app = appRef.current;
    const bottom = bottomBarRef.current;
    const top = topBarRef.current;
    if (!app || !bottom) return;
    const update = () => {
      if (top) app.style.setProperty("--top-bar-h", `${top.offsetHeight}px`);
      if (bottom.offsetHeight > 0) {
        app.style.setProperty("--bottom-bar-h", `${bottom.offsetHeight}px`);
      } else {
        app.style.removeProperty("--bottom-bar-h");
      }
    };

    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    if (top) observer.observe(top);
    observer.observe(bottom);
    return () => observer.disconnect();
  }, [appRef, topBarRef, bottomBarRef]);
}
