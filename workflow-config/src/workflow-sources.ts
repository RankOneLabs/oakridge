import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface WorkflowSource {
  readonly name: string;
  readonly path: string;
  readonly audience: "user" | "test_fixture";
}

export function discoverWorkflowSources(root: string): readonly WorkflowSource[] {
  const directories = [
    { directory: "workflow-config", audience: "user" },
    { directory: "workflow-config/samples", audience: "test_fixture" },
  ] as const;
  const sources = directories.flatMap(({ directory, audience }) => {
    const path = join(root, directory);
    if (!existsSync(path) && audience === "test_fixture") return [];
    return readdirSync(path, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".yaml"))
      .map((entry): WorkflowSource => ({
        name: entry.name.slice(0, -".yaml".length),
        path: join(directory, entry.name),
        audience,
      }));
  }).sort((left, right) => left.name.localeCompare(right.name));
  const duplicate = sources.find((source, index) => sources[index - 1]?.name === source.name);
  if (duplicate) throw new Error(`Duplicate workflow name: ${duplicate.name}`);
  return sources;
}
