const TONES = {
  slate: "bg-stone-100 text-stone-700 ring-stone-200",
  green: "bg-emerald-100 text-emerald-800 ring-emerald-200",
  amber: "bg-amber-100 text-amber-800 ring-amber-200",
  red: "bg-rose-100 text-rose-800 ring-rose-200",
  sky: "bg-sky-100 text-sky-800 ring-sky-200",
} as const;

export function Badge({
  label,
  tone = "slate",
}: {
  label: string;
  tone?: keyof typeof TONES;
}) {
  return (
    <span
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-[0.18em] ring-1 ring-inset ${TONES[tone]}`}
    >
      {label}
    </span>
  );
}
