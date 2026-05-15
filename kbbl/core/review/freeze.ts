import type { Database } from "bun:sqlite";
import { reviewEvents } from "./events";

export function isFrozen(db: Database, target_type: string, target_id: string): boolean {
  return db
    .prepare<{ v: number }, [string, string]>(
      "SELECT 1 AS v FROM frozen_artifacts WHERE target_type = ? AND target_id = ?",
    )
    .get(target_type, target_id) != null;
}

export function freeze(db: Database, target_type: string, target_id: string): void {
  const row = db
    .prepare<{ target_type: string; target_id: string }, [string, string]>(
      "INSERT OR IGNORE INTO frozen_artifacts (target_type, target_id) VALUES (?, ?) RETURNING target_type, target_id",
    )
    .get(target_type, target_id);
  if (row != null) {
    reviewEvents.emit("artifact.frozen", { target_type, target_id });
  }
}

export function unfreeze(db: Database, target_type: string, target_id: string): void {
  const row = db
    .prepare<{ target_type: string; target_id: string }, [string, string]>(
      "DELETE FROM frozen_artifacts WHERE target_type = ? AND target_id = ? RETURNING target_type, target_id",
    )
    .get(target_type, target_id);
  if (row != null) {
    reviewEvents.emit("artifact.reopened", { target_type, target_id });
  }
}
