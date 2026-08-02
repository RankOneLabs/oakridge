import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postAtomEdit } from "../client";
import type { PostAtomEditRequest } from "../types";
export function useAtomEdit(artifactId: string) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostAtomEditRequest) => postAtomEdit(artifactId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId] }); } }); }
