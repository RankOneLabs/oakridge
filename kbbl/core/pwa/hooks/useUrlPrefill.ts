import { useEffect, useRef, useState } from "react";

import { toPositiveSafeInt } from "../lib/session";

export interface UrlPrefill {
  initialWorkdir: string;
  initialTaskId: string;
  initialProfileId: string;
  workdirTouchedInitial: boolean;
  autostartPending: boolean;
  setAutostartPending: (v: boolean) => void;
  profileLockedRef: React.MutableRefObject<boolean>;
}

interface InitialUrl {
  workdir: string;
  taskId: string;
  profileId: string;
  autostart: boolean;
  hadParams: boolean;
}

function readInitialUrl(): InitialUrl {
  const params = new URLSearchParams(window.location.search);
  if (params.size === 0) {
    return { workdir: "", taskId: "", profileId: "", autostart: false, hadParams: false };
  }
  const tid = toPositiveSafeInt(params.get("task_id"));
  const pid = toPositiveSafeInt(params.get("profile_id"));
  return {
    workdir: params.get("workdir") ?? "",
    taskId: tid !== null ? String(tid) : "",
    profileId: pid !== null ? String(pid) : "",
    autostart: params.get("autostart") === "true",
    hadParams: true,
  };
}

export function useUrlPrefill(): UrlPrefill {
  const profileLockedRef = useRef(false);
  const [initial] = useState<InitialUrl>(() => {
    const result = readInitialUrl();
    if (result.profileId) profileLockedRef.current = true;
    return result;
  });
  const [autostartPending, setAutostartPending] = useState(initial.autostart);

  useEffect(() => {
    if (!initial.hadParams) return;
    history.replaceState(null, "", window.location.pathname + window.location.hash);
  }, []);

  return {
    initialWorkdir: initial.workdir,
    initialTaskId: initial.taskId,
    initialProfileId: initial.profileId,
    workdirTouchedInitial: initial.workdir !== "",
    autostartPending,
    setAutostartPending,
    profileLockedRef,
  };
}
