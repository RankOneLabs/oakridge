interface Props {
  epic_id: string;
}

export function EpicDetailView({ epic_id }: Props) {
  return <div className="epic-detail">Loading epic {epic_id}…</div>;
}
