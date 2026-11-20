import { useEffect, useEffectEvent, useRef, type RefObject } from "react";
import { shouldLoadEarlier } from "../lib/thread-scroll";

interface LoadEarlierSentinelOptions {
  viewportRef: RefObject<HTMLDivElement | null>;
  hasEarlier: boolean;
  isLoadingEarlier: boolean;
  hasLoadError: boolean;
  onLoadEarlier: () => Promise<void>;
}

export function useLoadEarlierSentinel({ viewportRef, hasEarlier, isLoadingEarlier, hasLoadError, onLoadEarlier }: LoadEarlierSentinelOptions) {
  const sentinelRef = useRef<HTMLDivElement>(null);
  const isRequestInFlight = useRef(false);

  const loadWhenVisible = useEffectEvent((entries: IntersectionObserverEntry[]) => {
    if (hasLoadError || !shouldLoadEarlier({
      is_intersecting: entries.some((entry) => entry.isIntersecting),
      has_earlier: hasEarlier,
      is_loading_earlier: isLoadingEarlier || isRequestInFlight.current,
    })) return;

    isRequestInFlight.current = true;
    void onLoadEarlier().finally(() => { isRequestInFlight.current = false; });
  });

  useEffect(() => {
    const root = viewportRef.current;
    const sentinel = sentinelRef.current;
    if (!root || !sentinel || !hasEarlier || hasLoadError || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver((entries) => loadWhenVisible(entries), { root });
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [viewportRef, hasEarlier, hasLoadError]);

  return sentinelRef;
}
