export function TurnStateNotice({
  state,
  stopReason,
  detail,
}: {
  state: "cancelled" | "failed" | "unknown";
  stopReason: string | null;
  detail: string | null;
}) {
  const label =
    state === "cancelled"
      ? "turn cancelled"
      : state === "failed"
        ? "turn failed"
        : "turn outcome unknown";
  const extra = detail ?? stopReason;
  return (
    <div className="row row-system">
      <div className={`notice notice-turn-${state}`}>
        {label}
        {extra ? ` · ${extra}` : ""}
      </div>
    </div>
  );
}
