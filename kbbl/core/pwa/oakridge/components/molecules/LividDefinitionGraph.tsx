// kbbl rule 5: library CSS belongs beside the component consuming the library.
import "@xyflow/react/dist/style.css";
import "@rankonelabs/livid-react/styles.css";
import { LividDiagram, type LividDiagramProps } from "@rankonelabs/livid-react";
import type { definitionRegistry } from "../../lib/livid-graph-adapter";

export function LividDefinitionGraph(
  props: LividDiagramProps<typeof definitionRegistry>,
) {
  return (
    <div className="h-[600px]">
      <LividDiagram {...props} />
    </div>
  );
}
