export function useDirectEdit(
  target_type: string,
  target_id: string,
  author: string,
) {
  async function editAtom(
    anchor: string | null,
    prevValue: string | null,
    newValue: string,
  ): Promise<
    | { ok: true }
    | { ok: false; conflict: { current_value: string | null } }
  > {
    const res = await fetch("/atoms/edits", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        target_type,
        target_id,
        anchor,
        prev_value: prevValue,
        new_value: newValue,
        author,
      }),
    });

    if (res.status === 409) {
      const body = (await res.json()) as {
        error: string;
        current_value?: string | null;
      };
      return {
        ok: false,
        conflict: { current_value: body.current_value ?? null },
      };
    }

    if (!res.ok) {
      throw new Error(`editAtom failed: ${res.status}`);
    }

    return { ok: true };
  }

  return { editAtom };
}
