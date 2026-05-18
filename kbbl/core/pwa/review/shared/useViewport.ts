import { useEffect, useState } from "react";

interface ViewportState {
  width: number;
  isPhone: boolean;
  isTablet: boolean;
  isDesktop: boolean;
}

function getState(): ViewportState {
  const w = window.innerWidth;
  return {
    width: w,
    isPhone: w <= 767,
    isTablet: w >= 768 && w <= 1279,
    isDesktop: w >= 1280,
  };
}

export function useViewport(): ViewportState {
  const [state, setState] = useState<ViewportState>(getState);

  useEffect(() => {
    const phone = window.matchMedia("(max-width: 767px)");
    const tablet = window.matchMedia("(min-width: 768px) and (max-width: 1279px)");
    const desktop = window.matchMedia("(min-width: 1280px)");

    function update() {
      setState(getState());
    }

    phone.addEventListener("change", update);
    tablet.addEventListener("change", update);
    desktop.addEventListener("change", update);

    return () => {
      phone.removeEventListener("change", update);
      tablet.removeEventListener("change", update);
      desktop.removeEventListener("change", update);
    };
  }, []);

  return state;
}
