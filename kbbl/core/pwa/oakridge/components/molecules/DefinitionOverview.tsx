import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import {
  selectDefinitionSchemaParts,
  type DefinitionOverview as Overview,
} from "../../lib/definition-overview";
import {
  definitionSelectionHref,
  definitionSchemaElementId,
  definitionUnitHref,
} from "../../lib/definition-selection";

interface DefinitionOverviewProps {
  overview: Overview;
  selection?: import("../../../lib/hash").DefinitionSelection | null;
}
function SchemaType({ text, overview, selection }: { text: string; overview: Overview; selection?: import("../../../lib/hash").DefinitionSelection | null }) {
  return (
    <>
      {selectDefinitionSchemaParts(text, overview.schemas).map((part, index) =>
        part.kind === "schema" ? (
          <a key={index} href={`${definitionSelectionHref(overview.id, selection ?? null)}#${definitionSchemaElementId(part.text)}`}>
            {part.text}
          </a>
        ) : (
          part.text
        ),
      )}
    </>
  );
}
export function DefinitionOverview({ overview, selection }: DefinitionOverviewProps) {
  const [shouldShowFullId, setShouldShowFullId] = useState(false);
  async function onCopyDefinitionId(): Promise<void> {
    if (!navigator.clipboard?.writeText) {
      setShouldShowFullId(true);
      return;
    }
    try {
      await navigator.clipboard.writeText(overview.id);
    } catch {
      setShouldShowFullId(true);
    }
  }
  return (
    <section aria-label="Workflow overview" className="or-definition-overview">
      <h2>{overview.name}</h2>
      <p>
        Definition ID: <code title={overview.id}>{overview.id.slice(0, 12)}…</code>
        <Button variant="secondary" onClick={onCopyDefinitionId}>Copy definition ID</Button>
      </p>
      {shouldShowFullId && (
        <div>
          <p role="status">Copy unavailable. Select and copy the full definition ID.</p>
          <input aria-label="Full definition ID" value={overview.id} readOnly autoFocus onFocus={(event) => event.currentTarget.select()} className="w-full" />
        </div>
      )}
      <p>{overview.stages.length} stages · {overview.units.length} units · {overview.collections.length} collections · {overview.pools.length} pools</p>
      <details><summary>Workflow inputs, outputs and schemas</summary>
      <h3>Root input</h3>
      {typeof overview.input === "string" ? (
        <p>
          <SchemaType text={overview.input} overview={overview} selection={selection} />
        </p>
      ) : (
        <dl>
          {Object.entries(overview.input).map(([field, type]) => (
            <div key={field}>
              <dt>{field}</dt>
              <dd>
                <code>
                  <SchemaType
                    text={typeof type === "string" ? type : JSON.stringify(type)}
                    overview={overview} selection={selection}
                  />
                </code>
              </dd>
            </div>
          ))}
        </dl>
      )}
      <h3>Root outputs</h3>
      <dl>
        {Object.entries(overview.outputs).map(([name, expression]) => (
          <div key={name}>
            <dt>{name}</dt>
            <dd>
              <code>{expression}</code>
            </dd>
          </div>
        ))}
      </dl>
      <h3>Pools</h3>
      <ul>
        {overview.pools.map((pool) => (
          <li key={JSON.stringify([pool.scope, pool.name])}>
            {pool.scope ? pool.scope + "/" : ""}
            {pool.name}: {pool.capacity} ←{" "}
            {pool.units.map((path) => (
              <a key={path} href={definitionUnitHref(overview.id, path)}>
                {path}{" "}
              </a>
            ))}
          </li>
        ))}
      </ul>
      <h3>Schemas</h3>
      {overview.schemas.map((schema) => (
        <section key={schema.key} id={definitionSchemaElementId(schema.key)} tabIndex={-1}>
          <h4>{schema.key}</h4>
          <pre>{JSON.stringify(schema.shape, null, 2)}</pre>
        </section>
      ))}
      </details>
    </section>
  );
}
