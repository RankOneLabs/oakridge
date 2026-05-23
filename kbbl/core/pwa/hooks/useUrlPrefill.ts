import { useEffect, useState } from "react";

export interface UrlPrefill {
  initialWorkdir: string;
  workdirTouchedInitial: boolean;
  autostartPending: boolean;
  setAutostartPending: (v: boolean) => void;
}

interface InitialUrl {
  workdir: string;
  autostart: boolean;
  hadParams: boolean;
}

function readInitialUrl(): InitialUrl {
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) {
    return { workdir: "", autostart: false, hadParams: false };
  }
  return {
    workdir: params.get("workdir") ?? "",
    autostart: params.get("autostart") === "true",
    hadParams: true,
  };
}

export function useUrlPrefill(): UrlPrefill {
  const [initial] = useState<InitialUrl>(() => readInitialUrl());
  const [autostartPending, setAutostartPending] = useState(initial.autostart);

  useEffect(() => {
    if (!initial.hadParams) return;
    history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);

  return {
    initialWorkdir: initial.workdir,
    workdirTouchedInitial: initial.workdir !== "",
    autostartPending,
    setAutostartPending,
  };
}
