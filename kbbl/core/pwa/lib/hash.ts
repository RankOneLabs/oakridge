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
    // replaceState doesn't fire hashchange — dispatch manually so sibling
    // hash hooks (useHashRoute, etc.) re-read the now-empty hash.
    window.dispatchEvent(new Event("hashchange"));
  } else {
    window.location.hash = `sid=${encodeURIComponent(sid)}`;
  }
}

export type OakridgeSubRoute =
  | { sub: "runs" }
  | { sub: "run"; id: string }
  | { sub: "artifact"; id: string }
  | { sub: "new-run" }
  | { sub: "create-project" }
  | { sub: "defs" }
  | { sub: "def-new" }
  | { sub: "def-edit"; id: string };

export type HashRoute =
  | { view: "plan"; id: string }
  | { view: "brief"; id: string }
  | { view: "cohort"; id: string }
  | { view: "repo"; id: string }
  | { view: "epic"; id: string }
  | { view: "oakridge"; route: OakridgeSubRoute };

function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

export function readHashRoute(): HashRoute | null {
  const hash = window.location.hash.slice(1);
  if (hash.startsWith("plan/")) {
    const id = hash.slice(5);
    if (id) return { view: "plan", id };
  }
  if (hash.startsWith("brief/")) {
    const id = hash.slice(6);
    if (id) return { view: "brief", id };
  }
  if (hash.startsWith("cohort/")) {
    const id = hash.slice(7);
    if (id) return { view: "cohort", id };
  }
  if (hash.startsWith("repo/")) {
    const id = hash.slice(5);
    if (id) return { view: "repo", id };
  }
  if (hash.startsWith("epic/")) {
    const id = hash.slice(5);
    if (id) return { view: "epic", id };
  }
  if (hash === "oakridge" || hash.startsWith("oakridge/")) {
    const rest = hash.slice("oakridge".length);
    if (rest === "" || rest === "/") {
      return { view: "oakridge", route: { sub: "runs" } };
    }
    if (rest.startsWith("/run/")) {
      const raw = rest.slice("/run/".length);
      if (raw) {
        const id = tryDecode(raw);
        return { view: "oakridge", route: { sub: "run", id } };
      }
    }
    if (rest.startsWith("/artifact/")) {
      const raw = rest.slice("/artifact/".length);
      if (raw) {
        const id = tryDecode(raw);
        return { view: "oakridge", route: { sub: "artifact", id } };
      }
    }
    if (rest === "/new-run") {
      return { view: "oakridge", route: { sub: "new-run" } };
    }
    if (rest === "/create-project") {
      return { view: "oakridge", route: { sub: "create-project" } };
    }
    if (rest === "/defs") {
      return { view: "oakridge", route: { sub: "defs" } };
    }
    if (rest === "/def-new") {
      return { view: "oakridge", route: { sub: "def-new" } };
    }
    if (rest.startsWith("/def-edit/")) {
      const raw = rest.slice("/def-edit/".length);
      if (raw) {
        const id = tryDecode(raw);
        return { view: "oakridge", route: { sub: "def-edit", id } };
      }
    }
    return { view: "oakridge", route: { sub: "runs" } };
  }
  return null;
}
