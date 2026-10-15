import { useMutation, useQueryClient } from "@tanstack/react-query";
import { postAtomEdit } from "../client";
import type { PostAtomEditRequest } from "../types";
export function useAtomEdit(revisionId: string, artifactId = revisionId) { const client = useQueryClient(); return useMutation({ mutationFn: (request: PostAtomEditRequest) => postAtomEdit(revisionId, request), onSuccess: () => { void client.invalidateQueries({ queryKey: ["oakridge", "artifact", artifactId] }); } }); }
