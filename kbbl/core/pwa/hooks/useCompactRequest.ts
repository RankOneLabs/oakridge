import { useMutation } from "@tanstack/react-query";

export function useCompactRequest(
  sid: string,
  onSuccess: () => void,
): { trigger: () => Promise<void> } {
  const mutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/${encodeURIComponent(sid)}/compact`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
    },
    onSuccess,
  });
  // Swallow errors here so the banner stays visible for the operator to
  // retry — matches the prior shape's `catch {}` semantics.
  return {
    trigger: () => mutation.mutateAsync().catch(() => {}),
  };
}
