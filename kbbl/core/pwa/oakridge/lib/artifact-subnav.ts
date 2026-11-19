/** One entry in an artifact viewer's section subnav: the section it shows, its label, and how many items it holds when that is countable. */
export interface SubnavSection<Section extends string> {
  readonly value: Section;
  readonly label: string;
  readonly count: number | null;
}

/** The label a subnav entry shows, with its item count when it has one. */
export const subnavSectionLabel = <Section extends string>({ label, count }: SubnavSection<Section>): string =>
  count === null ? label : `${label} (${count})`;

/** What a tabbed artifact viewer's panels can read and do: the shown section, and links that land inside another section. */
export interface SectionTabsState<Section extends string> {
  readonly active: Section;
  readonly select: (section: Section) => void;
  /** Show a section, then bring an element in it into view once it has rendered. */
  readonly openAnchor: (section: Section, anchor_id: string) => void;
}
