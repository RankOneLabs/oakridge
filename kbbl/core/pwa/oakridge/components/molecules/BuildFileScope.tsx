import { Chip, type ChipTone } from "../../../components/atoms/Chip";
import type { FileScopeComparison } from "../../lib/build-result";
import { artifactLabelClass } from "./ArtifactSection";

interface GroupProps {
  label: string;
  files: string[];
  tone: ChipTone;
  note: string;
  testId: string;
}

function FileGroup({ label, files, tone, note, testId }: GroupProps) {
  if (files.length === 0) return null;
  return (
    <div className="flex flex-col gap-1" data-testid={testId}>
      <div className="flex items-center gap-2">
        <Chip tone={tone}>{files.length}</Chip>
        <span className={artifactLabelClass}>{label}</span>
      </div>
      <p className="text-xs text-[var(--text-muted)]">{note}</p>
      <ul className="m-0 flex list-none flex-col gap-0.5 p-0 pl-1">
        {files.map((file) => <li key={file} className="font-mono text-xs text-[var(--text-secondary)]">{file}</li>)}
      </ul>
    </div>
  );
}

/** Changed files read against the brief's files in scope: what landed as planned, what strayed, what was never touched. */
export function BuildFileScope({ comparison }: { comparison: FileScopeComparison }) {
  return (
    <div className="flex flex-col gap-3">
      <FileGroup label="Changed outside the brief" files={comparison.changed_out_of_scope} tone="warning" note="Not named in the brief's files in scope." testId="or-build-files-out-of-scope" />
      <FileGroup label="In scope but untouched" files={comparison.planned_untouched} tone="muted" note="The brief planned these; the build left them alone." testId="or-build-files-untouched" />
      <FileGroup label="Changed as planned" files={comparison.changed_in_scope} tone="success" note="Named in the brief and changed." testId="or-build-files-in-scope" />
    </div>
  );
}
