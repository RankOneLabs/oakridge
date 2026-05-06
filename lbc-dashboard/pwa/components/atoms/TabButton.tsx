/**
 * Single tab button — selected state styled with bold weight + a
 * bottom border. Composed by the CellPanelHeader organism into a
 * tab bar.
 */
export function TabButton({
  label,
  selected,
  onClick,
}: {
  label: string;
  selected: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`cursor-pointer border-b-2 bg-transparent py-1.5 text-sm text-stone-700 ${
        selected
          ? "border-sky-700 font-bold"
          : "border-transparent font-normal"
      }`}
    >
      {label}
    </button>
  );
}
