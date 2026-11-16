import { stageElementId, type StageSectionProps } from "../../lib/stage-inspector";
export function StagePromptsSection({ model }: StageSectionProps) {
  return (
    <section aria-label="Prompts" className="rounded border border-[var(--border-muted)] p-3">
      <h3>Prompts</h3>
      {model.sections.prompts.map(reference => (
        <div key={`${reference.owner_kind}:${reference.owner_key}:${reference.mode}`}>
          <h4>{reference.owner_key}</h4>
          <dl><dt>{reference.mode}</dt><dd>{reference.path}</dd></dl>
        </div>
      ))}
      {model.sources.map(({ kind, name, label, content }) => (
        <details
          key={`${kind}:${name}`}
          id={stageElementId({ stage: model.name, kind, name })}
          tabIndex={-1}
        >
          <summary>{label}</summary>
          <pre>{content}</pre>
        </details>
      ))}
    </section>
  );
}
