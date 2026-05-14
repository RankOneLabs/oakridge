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
    const baseUrl = `/safir/atoms/${encodeURIComponent(target.type)}/${encodeURIComponent(target.id)}/edits`;

    // Determine length of the list by scanning the atom_map
    const indices = Object.keys(atomMap)
      .filter((k) => {
        // Matches field[i] or field[i].sub
        const m = k.match(new RegExp(`^${escapeRegex(field)}\\[(\\d+)\\]`));
        return m !== null;
      })
      .map((k) => {
        const m = k.match(new RegExp(`^${escapeRegex(field)}\\[(\\d+)\\]`));
        return m ? parseInt(m[1], 10) : -1;
      })
      .filter((n) => n >= 0);

    const len = indices.length > 0 ? Math.max(...indices) + 1 : 0;

    // Determine sub-keys: e.g. for decisions_made it's [".decision", ".rationale"]
    const subKeys = getSubKeys(field, index, atomMap);

    // Delete the target index atoms (empty string = tombstone per atom-edit API)
    for (const sub of subKeys) {
      const anchor = `${field}[${index}]${sub}`;
      await post(baseUrl, {
        anchor,
        prev_value: atomMap[anchor] ?? null,
        new_value: "",
        edited_by: "operator",
      });
    }

    // Shift subsequent indices down, matching sub-keys by name (not position)
    for (let i = index + 1; i < len; i++) {
      const subKeys = new Set([
        ...getSubKeys(field, i - 1, atomMap),
        ...getSubKeys(field, i, atomMap),
      ]);
      for (const sub of subKeys) {
        const srcAnchor = `${field}[${i}]${sub}`;
        const destAnchor = `${field}[${i - 1}]${sub}`;
        await post(baseUrl, {
          anchor: destAnchor,
          prev_value: atomMap[destAnchor] ?? null,
          new_value: atomMap[srcAnchor] ?? "",
          edited_by: "operator",
        });
      }
    }

    // Delete the last slot (it was either the deleted item or now a duplicate after shifting)
    if (len > 0) {
      const lastSubKeys = getSubKeys(field, len - 1, atomMap);
      for (const sub of lastSubKeys) {
        const anchor = `${field}[${len - 1}]${sub}`;
        if (index < len - 1) {
          // Already shifted — delete the last (now redundant) copy.
          // prev_value must reference the last slot's current value, not the deleted index.
          await post(baseUrl, {
            anchor,
            prev_value: atomMap[anchor] ?? null,
            new_value: "",
            edited_by: "operator",
          });
        }
      }
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
  // If atom_map has no entry for this index (e.g. new item), return empty string (simple field)
  return [""];
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function post(url: string, body: Record<string, unknown>): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(`atom edit failed (HTTP ${res.status}): ${text}`);
  }
}
