export function readHashSid(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get("sid");
}

export function writeHashSid(sid: string | null): void {
  if (sid === null) {
    // history.replaceState so hitting Back from a SessionView returns to the
    // prior tab/page rather than chaining through every sid the user viewed.
    history.replaceState(null, "", window.location.pathname + window.location.search);
  } else {
    window.location.hash = `sid=${encodeURIComponent(sid)}`;
  }
}

export function readHashTaskId(): number | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  const raw = params.get("task");
  if (raw === null) return null;
  if (!/^[1-9][0-9]*$/.test(raw)) return null;
  const n = Number.parseInt(raw, 10);
  return Number.isSafeInteger(n) ? n : null;
}

export function writeHashTaskId(taskId: number | null): void {
  if (taskId === null) {
    history.replaceState(
      null,
      "",
      window.location.pathname + window.location.search,
    );
  } else {
    window.location.hash = `task=${taskId}`;
  }
}

export function readHashRoute(): { view: "plan" | "brief"; id: string } | null {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith("plan/")) {
    const id = hash.slice(5);
    if (id) return { view: "plan", id };
  }
  if (hash.startsWith("brief/")) {
    const id = hash.slice(6);
    if (id) return { view: "brief", id };
  }
  return null;
}
