import { useEffect, useState } from "react";

export interface UrlPrefill {
  initialWorkdir: string | null;
  workdirTouchedInitial: boolean;
  autostartPending: boolean;
  setAutostartPending: (v: boolean) => void;
}

interface InitialUrl {
  workdir: string | null;
  autostart: boolean;
  hadParams: boolean;
}

function readInitialUrl(): InitialUrl {
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) {
    return { workdir: null, autostart: false, hadParams: false };
  }
  const workdirParam = params.get("workdir");
  return {
    workdir: workdirParam === "" ? null : workdirParam,
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
    workdirTouchedInitial: initial.workdir !== null,
    autostartPending,
    setAutostartPending,
  };
}
