// Where a session view scrolls, and where its input bar anchors.
//
// The standalone session view scrolls the document and fixes its bar to the
// viewport. A session mounted inside a pane scrolls its own element and must
// anchor the bar to that element instead — otherwise a viewport-fixed bar
// floats over unrelated chrome. Both are expressed here as data, so the hook
// and the view read a layout rather than branching on a caller's identity.

import type { RefObject } from "react";

import type { Theme } from "../types";

/**
 * What a session view scrolls. A discriminated union, not a nullable ref
 * beside a boolean: the container only exists for the element variant, and
 * only the element variant can supply one.
 */
export type SessionScrollHost =
  | { readonly kind: "document" }
  | { readonly kind: "element"; readonly container: RefObject<HTMLElement | null> };

export interface SessionSurfaceLayout {
  readonly scrollHost: SessionScrollHost;
  /**
   * `"viewport"` fixes the input bar to the window — the standalone mobile
   * path, where the bar must clear the iOS home indicator via safe-area
   * insets. `"surface"` sticks it to the bottom of the scrolling element,
   * for a session embedded in a pane.
   */
  readonly barAnchor: "viewport" | "surface";
}

/**
 * The standalone session view's layout, and the default when a caller passes
 * none — so the most-used surface in kbbl keeps today's code path rather than
 * being re-expressed through the new one.
 */
export const DOCUMENT_SESSION_SURFACE_LAYOUT: SessionSurfaceLayout = {
  scrollHost: { kind: "document" },
  barAnchor: "viewport",
};

/**
 * Which app-level affordances the session's host contributes to its top bar.
 *
 * The standalone route owns the whole window, so its bar carries the back
 * action out to the session list and the theme toggle. A session in a pane
 * owns neither: back and theme are shell concerns, and a pane-local copy of
 * them would give the operator two different "back"s with different meanings.
 * A discriminated union rather than a pair of optional callbacks — neither
 * host carries the other's fields, and "pane" has no payload to get wrong.
 */
export type SessionSurfaceChrome =
  | {
      readonly kind: "route";
      readonly theme: Theme;
      readonly onToggleTheme: () => void;
      readonly onBack: () => void;
    }
  | { readonly kind: "pane" };

/**
 * How close to the bottom still counts as "following along", in CSS pixels.
 * Generous enough to survive a partially-rendered last message; small enough
 * that a reader who scrolled up to read is not yanked back down.
 */
export const STICK_TO_BOTTOM_THRESHOLD = 80;

/**
 * A scroll host's geometry, in the shape both hosts can report:
 * `document.documentElement.scrollHeight` / `window.scrollY` /
 * `window.innerHeight` for the document, and the matching element properties
 * for an element.
 */
export interface ScrollMetrics {
  readonly scrollHeight: number;
  readonly scrollTop: number;
  readonly clientHeight: number;
  readonly threshold: number;
}

/**
 * Whether the reader is pinned near the bottom, and so wants new output to
 * follow. Exactly at the threshold counts as scrolled away — the comparison is
 * strict, so a reader sitting exactly `threshold` px up is left where they are.
 */
export const shouldStickToBottom = ({ scrollHeight, scrollTop, clientHeight, threshold }: ScrollMetrics): boolean =>
  scrollHeight - scrollTop - clientHeight < threshold;

export interface ScrollTargetInputs {
  readonly scrollHeight: number;
  /** Whether the reader was pinned to the bottom before this update. */
  readonly wasStuckToBottom: boolean;
  readonly pendingLength: number;
  readonly previousPendingLength: number;
}

export interface ScrollDecision {
  /** The stick state to carry into the next update. */
  readonly isStuckToBottom: boolean;
  /** The offset to scroll the host to, or null to leave the reader where they are. */
  readonly scrollTo: number | null;
}

/**
 * Whether this update should follow the output down, and how far.
 *
 * A locally-sent message (`pendingLength` grew) is an intent to follow along,
 * so it re-sticks even when the reader had scrolled up — sending is the one
 * action that says "I am here now".
 */
export const nextScrollTarget = ({ scrollHeight, wasStuckToBottom, pendingLength, previousPendingLength }: ScrollTargetInputs): ScrollDecision => {
  const isStuckToBottom = wasStuckToBottom || pendingLength > previousPendingLength;
  return { isStuckToBottom, scrollTo: isStuckToBottom ? scrollHeight : null };
};
