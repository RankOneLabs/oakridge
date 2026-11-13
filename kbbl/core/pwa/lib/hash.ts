// `RoutePaneTarget` is defined once in the workspace model
// (`oakridge/lib/run-workspace.ts`) so a parsed route and a workspace pane are
// the same type rather than two kept in step by hand. This module already owns
// the oakridge sub-route namespace, so the reference is not a new coupling.
import type { RoutePaneTarget } from "../oakridge/lib/run-workspace";
import type { ArtifactId, Sid } from "./ids";

type HashNavigationGuard = () => boolean;
let navigationGuard: HashNavigationGuard | null = null;
export function registerHashNavigationGuard(guard: HashNavigationGuard): () => void {
  navigationGuard = guard;
  return () => { if (navigationGuard === guard) navigationGuard = null; };
}
export const acceptHashNavigation = (): boolean => navigationGuard?.() ?? true;

export function readHashSid(): string | null {
  const hash = window.location.hash.slice(1);
  if (!hash) return null;
  const params = new URLSearchParams(hash);
  return params.get("sid");
}

export function writeHashSid(sid: string | null): void {
  if (sid === null) {
    // history.replaceState so hitting Back from a SessionView returns to the
    // explicit Sessions surface rather than chaining through every sid the
    // user viewed or falling through to the default Runs surface.
    history.replaceState(null, "", `${window.location.pathname}${window.location.search}#sessions`);
    // replaceState doesn't fire hashchange — dispatch manually so sibling
    // hash hooks (useHashRoute, etc.) re-read the explicit Sessions hash.
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

export type DefinitionSelection = { kind: "stage"; stage: string } | { kind: "unit"; path: string };

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
  | { sub: "grading-config"; version: number | null }
  | { sub: "defs" }
  | { sub: "def"; id: string; selection: DefinitionSelection | null };

export type HashRoute =
  | { view: "sessions"; route: { sub: "sessions" } }
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
  if (segments.length === 5 && paneKind === "prompt" && rawPaneId && segments[3] === "attempt" && segments[4]) return { sub: "run", id, pane: { kind: "prompt", unit_id: tryDecode(rawPaneId), attempt_id: tryDecode(segments[4]) } };
  if (segments.length === 5 && paneKind === "artifact" && rawPaneId && segments[3] === "revision" && segments[4]) return { sub: "run", id, pane: { kind: "artifact", artifact_id: tryDecode(rawPaneId) as ArtifactId, revision_id: tryDecode(segments[4]) } };
  if (segments.length === 3 && rawPaneId) {
    if (paneKind === "session") {
      return { sub: "run", id, pane: { kind: "session", session_id: tryDecode(rawPaneId) as Sid } };
    }
    if (paneKind === "unit") return { sub: "run", id, pane: { kind: "unit", unit_id: tryDecode(rawPaneId) } };
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
  if (pane.kind === "prompt") return `${base}/prompt/${encodeURIComponent(pane.unit_id)}/attempt/${encodeURIComponent(pane.attempt_id)}`;
  if (pane.kind === "unit") return `${base}/unit/${encodeURIComponent(pane.unit_id)}`;
  return `${base}/artifact/${encodeURIComponent(pane.artifact_id)}${pane.revision_id ? `/revision/${encodeURIComponent(pane.revision_id)}` : ""}`;
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

export function readHashRoute(
  rawHash = window.location.hash,
  search = window.location.search,
): HashRoute | null {
  const hash = (rawHash.startsWith("#") ? rawHash.slice(1) : rawHash).replace(/^\//, "");
  if (hash === "sessions") return { view: "sessions", route: { sub: "sessions" } };
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
    if (rest === "/grading-config") return { view: "oakridge", route: { sub: "grading-config", version: null } };
    const gradingVersion = /^\/grading-config\/versions\/([1-9]\d*)$/.exec(rest);
    if (gradingVersion && Number.isSafeInteger(Number(gradingVersion[1]))) return { view: "oakridge", route: { sub: "grading-config", version: Number(gradingVersion[1]) } };
    if (rest === "/defs") {
      return { view: "oakridge", route: { sub: "defs" } };
    }
    if (rest.startsWith("/defs/")) {
      // A declaration anchor is an exact DOM id: split it off before decoding and keep it verbatim.
      const anchorAt = rest.indexOf("#");
      const routePath = anchorAt === -1 ? rest : rest.slice(0, anchorAt);
      const anchor = anchorAt === -1 ? "" : rest.slice(anchorAt);
      const segments = routePath.slice("/defs/".length).split("/");
      const [rawId, kind, ...path] = segments;
      if (rawId && segments.every(Boolean)) {
        const id = tryDecode(rawId);
        if (segments.length === 1) return { view: "oakridge", route: { sub: "def", id, selection: null } };
        if (kind === "stages" && path.length === 1) return { view: "oakridge", route: { sub: "def", id, selection: { kind: "stage", stage: tryDecode(path[0] as string) + anchor } } };
        if (kind === "units" && path.length > 0) return { view: "oakridge", route: { sub: "def", id, selection: { kind: "unit", path: path.map(tryDecode).join("/") + anchor } } };
      }
    }
    return { view: "oakridge", route: { sub: "runs" } };
  }
  if (hash === "") {
    const params = new URLSearchParams(search);
    if (params.has("workdir") || params.get("autostart") === "true") {
      return { view: "sessions", route: { sub: "sessions" } };
    }
    return { view: "oakridge", route: { sub: "runs" } };
  }
  return null;
}
