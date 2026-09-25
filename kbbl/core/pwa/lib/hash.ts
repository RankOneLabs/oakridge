// `RoutePaneTarget` is defined once in the workspace model
// (`oakridge/lib/run-workspace.ts`) so a parsed route and a workspace pane are
// the same type rather than two kept in step by hand. This module already owns
// the oakridge sub-route namespace, so the reference is not a new coupling.
import type { RoutePaneTarget } from "../oakridge/lib/run-workspace";
import type { ArtifactId, Sid } from "./ids";

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

export type SessionHashTarget = "pending-permission";

export function writeHashSessionTarget(sid: string, target: SessionHashTarget): void {
  const params = new URLSearchParams();
  params.set("sid", sid);
  params.set("focus", target);
  window.location.hash = params.toString();
}

/** Link to one permission card, including when another request in that session is first. */
export function writeHashPermissionTarget(sid: string, requestId: string): void {
  const params = new URLSearchParams();
  params.set("sid", sid);
  params.set("focus", "permission");
  params.set("requestId", requestId);
  const hash = params.toString();
  if (window.location.hash.slice(1) === hash) {
    window.dispatchEvent(new Event("hashchange"));
    return;
  }
  window.location.hash = hash;
}

export function readHashPermissionTarget(): string | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("focus") === "permission" ? params.get("requestId") : null;
}

export function readHashSessionTarget(): SessionHashTarget | null {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return params.get("focus") === "pending-permission" ? "pending-permission" : null;
}

export type OakridgeSubRoute =
  | { sub: "runs" }
  | { sub: "review-inbox" }
  /** `#oakridge/run/:id`, optionally naming the pane to open in `#oakridge/run/:id/session/:sid` form. */
  | { sub: "run"; id: string; pane: RoutePaneTarget | null }
  | { sub: "artifact"; id: string }
  /** `#oakridge/session/:sid` — resolved to its run and replaced with the run-scoped form. */
  | { sub: "session"; session_id: Sid }
  | { sub: "new-run" }
  | { sub: "create-project" }
  | { sub: "defs" }
  | { sub: "def"; id: string }
  | { sub: "def-new" }
  | { sub: "def-edit"; id: string };

export type HashRoute =
  | { view: "oakridge"; route: OakridgeSubRoute };

function tryDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

/**
 * `#oakridge/run/:id`, with the optional `/session/:sid` or `/artifact/:id`
 * suffix that names the pane to open.
 *
 * Segments are split while still percent-encoded: every id reaches the hash
 * through `encodeURIComponent`, so a literal `/` inside one is `%2F` here and
 * cannot be mistaken for a separator. Decoding happens per segment afterwards.
 */
function parseRunRoute(rest: string): OakridgeSubRoute | null {
  const segments = rest.slice("/run/".length).split("/");
  const [rawId, paneKind, rawPaneId] = segments;
  if (!rawId) return null;
  const id = tryDecode(rawId);
  if (segments.length === 3 && rawPaneId) {
    if (paneKind === "session") {
      return { sub: "run", id, pane: { kind: "session", session_id: tryDecode(rawPaneId) as Sid } };
    }
    if (paneKind === "artifact") {
      return { sub: "run", id, pane: { kind: "artifact", artifact_id: tryDecode(rawPaneId) as ArtifactId } };
    }
  }
  return { sub: "run", id, pane: null };
}

/**
 * The canonical in-workspace URL for a run, with or without a pane. The one
 * place these hashes are built, so the parser above and every navigation that
 * produces one cannot disagree about encoding.
 */
export function formatRunWorkspaceHash(runId: string, pane: RoutePaneTarget | null): string {
  const base = `oakridge/run/${encodeURIComponent(runId)}`;
  if (pane === null) return base;
  if (pane.kind === "session") return `${base}/session/${encodeURIComponent(pane.session_id)}`;
  return `${base}/artifact/${encodeURIComponent(pane.artifact_id)}`;
}

/**
 * Swap the current hash for another without pushing a history entry, so Back
 * skips the legacy URL that was redirected away from instead of bouncing the
 * operator straight back into the redirect. `replaceState` doesn't fire
 * `hashchange`, so sibling hash hooks are nudged manually — same reason as
 * `writeHashSid`.
 */
export function replaceHashRoute(hash: string): void {
  history.replaceState(null, "", `#${hash}`);
  window.dispatchEvent(new Event("hashchange"));
}

export function readHashRoute(): HashRoute | null {
  const hash = window.location.hash.slice(1);
  if (hash === "oakridge" || hash.startsWith("oakridge/")) {
    const rest = hash.slice("oakridge".length);
    if (rest === "" || rest === "/") {
      return { view: "oakridge", route: { sub: "runs" } };
    }
    if (rest.startsWith("/run/")) {
      const route = parseRunRoute(rest);
      if (route) return { view: "oakridge", route };
    }
    if (rest.startsWith("/session/")) {
      const raw = rest.slice("/session/".length);
      if (raw) {
        return {
          view: "oakridge",
          route: { sub: "session", session_id: tryDecode(raw) as Sid },
        };
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
    if (rest === "/review-inbox") {
      return { view: "oakridge", route: { sub: "review-inbox" } };
    }
    if (rest === "/create-project") {
      return { view: "oakridge", route: { sub: "create-project" } };
    }
    if (rest === "/defs") {
      return { view: "oakridge", route: { sub: "defs" } };
    }
    if (rest.startsWith("/def/")) {
      const raw = rest.slice("/def/".length);
      if (raw) {
        const id = tryDecode(raw);
        return { view: "oakridge", route: { sub: "def", id } };
      }
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
