import { useState } from "react";

interface NotDeliveredItem {
  item: string;
  reason: string;
  notes?: string;
}

interface DeviationItem {
  instruction: string;
  actual: string;
  rationale?: string;
}

export interface Debrief {
  delivered_summary: string;
  not_delivered: NotDeliveredItem[];
  deviations: DeviationItem[];
}

interface Props {
  debrief: Debrief;
  atomMap: Record<string, string>;
}

/** Case-insensitive longest-substring match. Returns the anchor that best
 *  matches `text`, or null if no atom value is a substring of text (or
 *  vice versa) with at least 10 chars overlap. */
function findBestAtomAnchor(
  text: string,
  atomMap: Record<string, string>,
): string | null {
  const needle = text.toLowerCase();
  let bestAnchor: string | null = null;
  let bestLen = 9; // minimum 10-char match
  for (const [anchor, value] of Object.entries(atomMap)) {
    const haystack = value.toLowerCase();
    // Check both directions: needle in haystack, or haystack in needle
    let overlap = 0;
    if (haystack.includes(needle)) overlap = needle.length;
    else if (needle.includes(haystack)) overlap = haystack.length;
    else {
      // Partial overlap: find longest common substring naively
      overlap = longestCommonSubstring(needle, haystack);
    }
    if (overlap > bestLen) {
      bestLen = overlap;
      bestAnchor = anchor;
    }
  }
  return bestAnchor;
}

function longestCommonSubstring(a: string, b: string): number {
  let best = 0;
  for (let i = 0; i < a.length; i++) {
    for (let j = 0; j < b.length; j++) {
      let len = 0;
      while (i + len < a.length && j + len < b.length && a[i + len] === b[j + len]) {
        len++;
      }
      if (len > best) best = len;
    }
  }
  return best;
}

export function DebriefOverlay({ debrief, atomMap }: Props) {
  const [expanded, setExpanded] = useState(false);

  const { not_delivered, deviations, delivered_summary } = debrief;

  // Build per-anchor annotation maps
  const deviationsByAnchor: Record<string, DeviationItem[]> = {};
  const unanchoredDeviations: DeviationItem[] = [];
  for (const d of deviations) {
    const anchor = findBestAtomAnchor(d.instruction, atomMap);
    if (anchor) {
      deviationsByAnchor[anchor] = [...(deviationsByAnchor[anchor] ?? []), d];
    } else {
      unanchoredDeviations.push(d);
    }
  }

  const notDeliveredByAnchor: Record<string, NotDeliveredItem[]> = {};
  const unanchoredNotDelivered: NotDeliveredItem[] = [];
  for (const nd of not_delivered) {
    const anchor = findBestAtomAnchor(nd.item, atomMap);
    if (anchor) {
      notDeliveredByAnchor[anchor] = [...(notDeliveredByAnchor[anchor] ?? []), nd];
    } else {
      unanchoredNotDelivered.push(nd);
    }
  }

  return (
    <div className="debrief-overlay">
      <div className="debrief-strip">
        <span className="debrief-strip-summary">{delivered_summary}</span>
        {not_delivered.length > 0 && (
          <span className="debrief-strip-badge debrief-strip-badge--not-delivered">
            {not_delivered.length} not delivered
          </span>
        )}
        {deviations.length > 0 && (
          <span className="debrief-strip-badge debrief-strip-badge--deviations">
            {deviations.length} deviation{deviations.length !== 1 ? "s" : ""}
          </span>
        )}
        <button
          type="button"
          className="debrief-strip-expand"
          onClick={() => setExpanded((p) => !p)}
        >
          {expanded ? "collapse debrief" : "debrief details"}
        </button>
      </div>

      {expanded && (
        <div className="debrief-details">
          <div className="debrief-detail-section">
            <h4>Delivered</h4>
            <p>{delivered_summary}</p>
          </div>
          {not_delivered.length > 0 && (
            <div className="debrief-detail-section">
              <h4>Not delivered</h4>
              <ul>
                {not_delivered.map((nd, i) => (
                  <li key={i} className="debrief-nd-item">
                    <strong>{nd.item}</strong> — {nd.reason}
                    {nd.notes && <span className="debrief-nd-notes"> ({nd.notes})</span>}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {deviations.length > 0 && (
            <div className="debrief-detail-section">
              <h4>Deviations</h4>
              <ul>
                {deviations.map((d, i) => (
                  <li key={i} className="debrief-deviation-item">
                    <span className="debrief-deviation-instruction">{d.instruction}</span>
                    <span className="debrief-deviation-arrow"> → </span>
                    <span className="debrief-deviation-actual">{d.actual}</span>
                    {d.rationale && (
                      <span className="debrief-deviation-rationale"> ({d.rationale})</span>
                    )}
                  </li>
                ))}
              </ul>
            </div>
          )}
          {(unanchoredDeviations.length > 0 || unanchoredNotDelivered.length > 0) && (
            <div className="debrief-detail-section debrief-unanchored">
              <h4>Unanchored deviations</h4>
              {unanchoredDeviations.map((d, i) => (
                <div key={i} className="debrief-badge debrief-badge--deviation">
                  deviation: {d.instruction} → {d.actual}
                </div>
              ))}
              {unanchoredNotDelivered.map((nd, i) => (
                <div key={i} className="debrief-badge debrief-badge--not-delivered">
                  not delivered: {nd.item}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** Exported helper for testing the matching logic independently. */
export { findBestAtomAnchor };
