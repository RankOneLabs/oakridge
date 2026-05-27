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

export type HashRoute =
  | { view: "plan"; id: string }
  | { view: "brief"; id: string }
  | { view: "cohort"; id: string }
  | { view: "repo"; id: string }
  | { view: "epic"; id: string };

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
  return null;
}
