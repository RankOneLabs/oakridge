import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";

/** Every file a regeneration would replace or delete, relative to `directory`, whatever its extension. */
function presentFiles(directory: string): string[] {
  if (!existsSync(directory)) return [];
  return readdirSync(directory, { recursive: true, encoding: "utf8" })
    .filter((entry) => !lstatSync(resolve(directory, entry)).isDirectory());
}

/** The files in `directory` that differ from `generated`: stale or missing ones, then strays. */
export function selectDriftedFiles(directory: string, generated: ReadonlyMap<string, string>): string[] {
  const present = presentFiles(directory);
  const stale = [...generated]
    .filter(([file, text]) => !present.includes(file) || readFileSync(resolve(directory, file), "utf8") !== text)
    .map(([file]) => file);
  return [...stale, ...present.filter((file) => !generated.has(file))];
}
