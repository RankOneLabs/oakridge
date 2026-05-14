import type { ArtifactTarget } from "../shared/types";

export interface ListItemDeleteResult {
  deleteItem: (
    field: string,
    index: number,
    atomMap: Record<string, string>,
  ) => Promise<void>;
}

/** Encapsulates the delete + downward-shift sequence for list-element atoms. */
export function useListItemDelete(target: ArtifactTarget): ListItemDeleteResult {
  async function deleteItem(
    field: string,
    index: number,
    atomMap: Record<string, string>,
  ): Promise<void> {
    const indices = Object.keys(atomMap)
      .filter((k) => {
        const m = k.match(new RegExp(`^${escapeRegex(field)}\\[(\\d+)\\]`));
        return m !== null;
      })
      .map((k) => {
        const m = k.match(new RegExp(`^${escapeRegex(field)}\\[(\\d+)\\]`));
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((n) => n >= 0);

    const len = indices.length > 0 ? Math.max(...indices) + 1 : 0;

    if (index < 0 || index >= len) return;

    const subKeys = getSubKeys(field, index, atomMap);
    const edits: Array<{ anchor: string; prev_value: string | null; new_value: string; edited_by: string }> = [];

    // Tombstone only when no shift will overwrite this slot
    if (index >= len - 1) {
      for (const sub of subKeys) {
        const anchor = `${field}[${index}]${sub}`;
        edits.push({ anchor, prev_value: atomMap[anchor] ?? null, new_value: "", edited_by: "operator" });
      }
    }

    // Shift subsequent indices down
    for (let i = index + 1; i < len; i++) {
      const shiftSubKeys = new Set([
        ...getSubKeys(field, i - 1, atomMap),
        ...getSubKeys(field, i, atomMap),
      ]);
      for (const sub of shiftSubKeys) {
        const srcAnchor = `${field}[${i}]${sub}`;
        const destAnchor = `${field}[${i - 1}]${sub}`;
        edits.push({ anchor: destAnchor, prev_value: atomMap[destAnchor] ?? null, new_value: atomMap[srcAnchor] ?? "", edited_by: "operator" });
      }
    }

    // Tombstone the last slot (now a duplicate after shifting)
    if (len > 0 && index < len - 1) {
      const lastSubKeys = getSubKeys(field, len - 1, atomMap);
      for (const sub of lastSubKeys) {
        const anchor = `${field}[${len - 1}]${sub}`;
        edits.push({ anchor, prev_value: atomMap[anchor] ?? null, new_value: "", edited_by: "operator" });
      }
    }

    if (edits.length === 0) return;

    const res = await fetch(
      `/safir/atoms/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}/edits/batch`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ edits }),
      },
    );
    if (!res.ok) {
      const body = (await res.json().catch(() => ({}))) as { error?: string; conflict_index?: number };
      const detail = body.conflict_index != null
        ? `conflict at edit ${body.conflict_index} of ${edits.length}; nothing changed`
        : body.error ?? `HTTP ${res.status}`;
      throw new Error(`atom edit batch failed: ${detail}`);
    }
  }

  return { deleteItem };
}

function getSubKeys(field: string, index: number, atomMap: Record<string, string>): string[] {
  const prefix = `${field}[${index}]`;
  const found = Object.keys(atomMap)
    .filter((k) => k.startsWith(prefix))
    .map((k) => k.slice(prefix.length));
  if (found.length > 0) return found;
  return [""];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
