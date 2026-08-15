import { useMutation } from "@tanstack/react-query";
import { pingThread } from "../client";
export function usePingThread(_artifactId: string) { return useMutation({ mutationFn: (threadId: string) => pingThread(threadId, crypto.randomUUID()) }); }
