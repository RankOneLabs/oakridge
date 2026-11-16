import { useQuery } from "@tanstack/react-query";
import { readPromptVersions } from "../client-prompt-versions";
export function usePromptVersions(path: string, is_open = true) {
  return useQuery({queryKey: ["oakridge", "prompt-versions", path], queryFn: () => readPromptVersions(path), enabled: is_open});
}
