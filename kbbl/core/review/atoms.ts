import type { Database } from "bun:sqlite";

export interface AtomEdit {
  id: string;
  target_type: string;
  target_id: string;
  anchor: string | null;
  prior_value: string | null;
  new_value: string;
  author: string;
  created_at: string;
}

export function getLiveValue(
  db: Database,
  target_type: string,
  target_id: string,
  anchor: string | null,
): string | null {
  let row: { new_value: string } | null | undefined;
  if (anchor === null) {
    row = db
      .prepare<{ new_value: string }, [string, string]>(
        "SELECT new_value FROM atom_edits WHERE target_type = ? AND target_id = ? AND anchor IS NULL ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(target_type, target_id);
  } else {
    row = db
      .prepare<{ new_value: string }, [string, string, string]>(
        "SELECT new_value FROM atom_edits WHERE target_type = ? AND target_id = ? AND anchor = ? ORDER BY created_at DESC, rowid DESC LIMIT 1",
      )
      .get(target_type, target_id, anchor);
  }
  return row?.new_value ?? null;
}

export function appendEdit(
  db: Database,
  edit: {
    id: string;
    target_type: string;
    target_id: string;
    anchor: string | null;
    prior_value: string | null;
    new_value: string;
    author: string;
  },
): AtomEdit {
  return db
    .prepare<AtomEdit, [string, string, string, string | null, string | null, string, string]>(
      "INSERT INTO atom_edits (id, target_type, target_id, anchor, prior_value, new_value, author) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING *",
    )
    .get(edit.id, edit.target_type, edit.target_id, edit.anchor, edit.prior_value, edit.new_value, edit.author)!;
}

export function listEdits(db: Database, target_type: string, target_id: string): AtomEdit[] {
  return db
    .prepare<AtomEdit, [string, string]>(
      "SELECT * FROM atom_edits WHERE target_type = ? AND target_id = ? ORDER BY created_at ASC, rowid ASC",
    )
    .all(target_type, target_id);
}
