export function useCompactRequest(
  sid: string,
  onSuccess: () => void,
): { trigger: () => Promise<void> } {
  async function trigger() {
    try {
      const res = await fetch(`/${encodeURIComponent(sid)}/compact`, {
        method: "POST",
      });
      if (res.ok) onSuccess();
    } catch {
      // keep banner visible so operator can retry
    }
  }
  return { trigger };
}
