import { useMutation, useQueryClient } from "@tanstack/react-query";

export function useDirectEdit(
  target_type: string,
  target_id: string,
  author: string,
) {
  const queryClient = useQueryClient();

  const mutation = useMutation({
    mutationFn: async (vars: {
      anchor: string | null;
      prevValue: string | null;
      newValue: string;
    }): Promise<
      | { ok: true }
      | { ok: false; conflict: { current_value: string | null } }
    > => {
      const res = await fetch("/atoms/edits", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          target_type,
          target_id,
          anchor: vars.anchor,
          prev_value: vars.prevValue,
          new_value: vars.newValue,
          author,
        }),
      });

      if (res.status === 409) {
        const body = (await res.json()) as {
          error: string;
          current_value?: string | null;
        };
        // 409 is a domain-level conflict — return rather than throw so the
        // caller can render the conflict UI without React Query treating
        // it as an error.
        return {
          ok: false,
          conflict: { current_value: body.current_value ?? null },
        };
      }

      if (!res.ok) {
        throw new Error(`editAtom failed: ${res.status}`);
      }

      return { ok: true };
    },
    onSuccess: (data) => {
      if (!data.ok) return;
      void queryClient.invalidateQueries({
        queryKey: ["atoms", "edits", { target_type, target_id }],
      });
      void queryClient.invalidateQueries({
        queryKey: ["review", "frozen", { target_type, target_id }],
      });
    },
  });

  async function editAtom(
    anchor: string | null,
    prevValue: string | null,
    newValue: string,
  ) {
    return mutation.mutateAsync({ anchor, prevValue, newValue });
  }

  return { editAtom };
}
