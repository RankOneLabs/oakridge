import { Chip } from "../../../components/atoms/Chip";
import { selectTestEvidenceText, type TestEvidence } from "../../lib/build-result";
import { ExpandableText } from "./ExpandableText";

interface Props {
  tests: TestEvidence;
  testId: string;
}

/** Pass and fail counts over whatever prose the run recorded about its tests. */
export function TestEvidenceBlock({ tests, testId }: Props) {
  const evidence = selectTestEvidenceText(tests);
  return (
    <div className="flex flex-col gap-2" data-testid={testId}>
      <div className="flex flex-wrap gap-1.5">
        <Chip tone={tests.passed > 0 ? "success" : "muted"}>{tests.passed} passed</Chip>
        <Chip tone={tests.failed > 0 ? "danger" : "muted"}>{tests.failed} failed</Chip>
      </div>
      {evidence.map((text, index) => (
        <div key={index} className="rounded-md bg-[var(--bg-code)] px-3 py-2">
          <ExpandableText text={text} className="whitespace-pre-wrap font-mono text-xs text-[var(--text-secondary)]" />
        </div>
      ))}
    </div>
  );
}
