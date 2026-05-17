import { useState, useEffect } from "react";

import type { Theme } from "../types";
import { THEME_STORAGE_KEY, readStoredTheme } from "../lib/storage";

export function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(readStoredTheme);
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    try {
      localStorage.setItem(THEME_STORAGE_KEY, theme);
    } catch {}
  }, [theme]);
  return [theme, () => setTheme((p) => (p === "dark" ? "light" : "dark"))];
}
