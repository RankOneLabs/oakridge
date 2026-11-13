import { useState } from "react";
import { Button } from "../../../components/atoms/Button";
import { GradingDefinitionEditor } from "./GradingDefinitionEditor";
import { GradingJsonField } from "../molecules/GradingConfigFields";
import { GradingConfigFeedback } from "../molecules/GradingConfigFeedback";
import { GradingConfigDiff, GradingConfigSummary } from "../molecules/GradingConfigSummary";
import { readGradingConfiguration, readGradingVersion, saveGradingDraft, validateGradingDraft, publishGradingDraft, type GradingConfigurationRead } from "../../client-grading-config";
import { atPath, configurationDiff, configurationHeader, createDraft, definitionSummaries, editDraft, hasJsonErrors, jsonList, parseDefinitions, parseJson, publishedDefinitions, replaceDefinitions, saveFailed, saveSucceeded, validationIssues, type GradingFeedback, type GradingJsonInputs, type GradingPath } from "../../lib/grading-config";
import type { ObservationJsonValue as Json } from "../../grading-contracts/domain/primitives";

interface GradingConfigBrowserProps {
  readonly initial: GradingConfigurationRead;
  readonly version: number | null;
  readonly onNavigate: (version: number | null) => void;
  readonly onReload: () => void;
}
export function GradingConfigBrowser({ initial, version, onNavigate, onReload }: GradingConfigBrowserProps) {
  const [read, setRead] = useState(initial);
  const [draft, setDraft] = useState(() => createDraft(initial.draft, initial.versions.latest_version));
  const [feedback, setFeedback] = useState<GradingFeedback | null>(null);
  const [selectedIndex, setSelectedIndex] = useState<number | null>(0);
  const [isRaw, setIsRaw] = useState(false);
  const [rawText, setRawText] = useState("");
  const [rawError, setRawError] = useState<string | null>(null);
  const [jsonInputs, setJsonInputs] = useState<GradingJsonInputs>({});
  const [isComparing, setIsComparing] = useState(false);
  const [isBusy, setIsBusy] = useState(false);
  const [restoreVersion, setRestoreVersion] = useState<number | null>(null);
  const header = configurationHeader(draft, read.latest);
  const summaries = definitionSummaries(version === null ? draft.definitions : publishedDefinitions(read.selected));
  const isBlocked = rawError !== null || hasJsonErrors(jsonInputs);
  const issues = validationIssues(feedback);
  const edit = (path: GradingPath, value: Json) => {
    setDraft((current) => editDraft(current, path, value));
    // A structural edit can move list indexes. Invalid text must be fixed before structural edits.
    setJsonInputs({});
  };
  const jsonField = (label: string, relative: GradingPath) => {
    const path: GradingPath = [selectedIndex ?? 0, ...relative];
    const key = JSON.stringify(path), input = jsonInputs[key];
    return <GradingJsonField key={key} label={label} text={input?.text ?? JSON.stringify(atPath(draft.definitions, path) ?? null, null, 2)} error={input?.error ?? undefined} onChange={(text) => {
      const parsed = parseJson(text);
      setJsonInputs((current) => ({ ...current, [key]: { path, text, error: parsed.ok ? null : parsed.error } }));
      if (parsed.ok) setDraft((current) => editDraft(current, path, parsed.value));
    }} />;
  };
  const save = async () => {
    setIsBusy(true); setFeedback({ kind: "saving" });
    const result = await saveGradingDraft(draft.definitions, draft.baseDigest);
    if (result.ok && result.value?.digest && result.value.document?.status === "draft" && Array.isArray(result.value.document.definitions)) {
      setDraft((current) => saveSucceeded(current, result.value)); setFeedback({ kind: "saved", digest: result.value.digest });
    } else {
      setDraft(saveFailed);
      setFeedback(result.ok ? { kind: "transport_error", detail: "Unexpected save response" } : result.feedback);
    }
    setIsBusy(false);
  };
  const validate = async () => {
    setIsBusy(true); setFeedback({ kind: "validating" });
    setFeedback(await validateGradingDraft()); setIsBusy(false);
  };
  const publish = async () => {
    setIsBusy(true); setFeedback({ kind: "publishing" });
    const outcome = await publishGradingDraft({ expected_draft_digest: draft.baseDigest, expected_latest_version: draft.latestVersionSeen });
    setFeedback(outcome);
    if (outcome.kind === "published" || outcome.kind === "unchanged" || outcome.kind === "reapplied") {
      setDraft((current) => ({ ...current, latestVersionSeen: outcome.version }));
      const refreshed = await readGradingConfiguration(version);
      if (refreshed.ok) setRead(refreshed.value);
    }
    setIsBusy(false);
  };
  const initialize = async (number: number) => {
    setRestoreVersion(null); setIsBusy(true); setFeedback({ kind: "saving" });
    const source = await readGradingVersion(number);
    if (!source.ok) { setFeedback(source.feedback); setIsBusy(false); return; }
    const result = await saveGradingDraft(publishedDefinitions(source.value), draft.baseDigest);
    if (result.ok && result.value?.digest && result.value.document?.status === "draft" && Array.isArray(result.value.document.definitions)) {
      setDraft((current) => saveSucceeded(current, result.value));
      setJsonInputs({}); setRawError(null); setIsRaw(false);
      setFeedback({ kind: "saved", digest: result.value.digest });
    } else setFeedback(result.ok ? { kind: "transport_error", detail: "Unexpected save response" } : result.feedback);
    setIsBusy(false);
  };
  const requestRestore = (number: number) => {
    if (draft.dirty || isBlocked) setRestoreVersion(number);
    else void initialize(number);
  };
  const navigate = (number: number | null) => {
    if ((draft.dirty || isBlocked) && !window.confirm("Discard unsaved local edits and open another view?")) return;
    onNavigate(number);
  };
  return <div className="mx-auto grid w-full max-w-6xl gap-5 p-4 md:p-6" data-testid="grading-config-browser">
    <header className="grid gap-2"><p className="text-sm text-[var(--text-muted)]">Oakridge / Configuration</p><h1 className="text-2xl font-semibold">Grading configuration</h1>
      <p>{header.published}</p><p data-testid="grading-draft-status">{header.draft}</p>
      <p className="text-sm">The whole definitions array is one versioned configuration.</p>
      <details><summary>Runtime status</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(read.runtime, null, 2)}</pre></details>
    </header>
    <nav aria-label="Grading versions" className="flex flex-wrap gap-2">
      <Button disabled={isBusy} onClick={() => navigate(null)}>Latest and draft</Button>
      {read.versions.versions.map((item) => <Button key={item.version} disabled={isBusy} onClick={() => navigate(item.version)}>Version {item.version}</Button>)}
      {read.versions.damaged_versions.map((item) => <p role="alert" key={item.version}>Version {item.version} unavailable: {item.error.detail}</p>)}
      <Button disabled={isBusy} onClick={() => { if ((!draft.dirty && !isBlocked) || window.confirm("Discard local edits and reload the draft?")) onReload(); }}>Reload</Button>
    </nav>
    <GradingConfigFeedback feedback={feedback} />
    {version !== null ? <section className="grid gap-3"><h2>Published version {version} · read-only</h2><p>{read.selected?.published_at}</p>
      <Button disabled={isBusy} onClick={() => requestRestore(version)}>Initialize draft from this version</Button>
      {summaries.map((summary) => <article key={summary.index} className="rounded border border-[var(--border-muted)] p-4"><GradingConfigSummary summary={summary} /><details><summary>Definition sections (read-only JSON)</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(publishedDefinitions(read.selected)[summary.index], null, 2)}</pre></details></article>)}
    </section> : <>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" disabled={isBusy || isBlocked} onClick={() => void save()}>Save draft</Button>
        <Button disabled={isBusy || isBlocked || draft.dirty || draft.baseDigest === null} onClick={() => void validate()}>Validate saved draft</Button>
        <Button disabled={isBusy || isBlocked || draft.dirty || draft.baseDigest === null} onClick={() => void publish()}>Publish configuration</Button>
        <Button disabled={isBusy} onClick={() => setIsComparing((value) => !value)}>Compare with latest</Button>
        <Button disabled={isBusy || isBlocked} onClick={() => { if (!isRaw) setRawText(JSON.stringify(draft.definitions, null, 2)); setIsRaw((value) => !value); }}>{isRaw ? "Structured sections" : "Raw JSON"}</Button>
      </div>
      {draft.dirty && <p>Save the shared draft before validating or publishing.</p>}
      {hasJsonErrors(jsonInputs) && <p role="alert">Fix the JSON field before saving, switching mode, or changing structure.</p>}
      {isComparing && (read.latest ? <GradingConfigDiff differences={configurationDiff(publishedDefinitions(read.latest), draft.definitions)} /> : <p>No latest published document available to compare.</p>)}
      <fieldset disabled={isBusy} className="min-w-0">
        {isRaw ? <GradingJsonField label="Whole definitions array (raw JSON)" text={rawText} error={rawError ?? undefined} onChange={(text) => {
          setRawText(text); const parsed = parseDefinitions(text);
          setRawError(parsed.ok ? null : parsed.error);
          if (parsed.ok) setDraft((current) => replaceDefinitions(current, jsonList(parsed.value)));
        }} /> : <div className="grid gap-5 md:grid-cols-[minmax(14rem,1fr)_minmax(0,2fr)]">
          <aside className="grid content-start gap-3"><h2>Shared draft · {summaries.length} definitions</h2>
            {summaries.map((summary) => <article key={summary.index} className="grid gap-2 rounded border border-[var(--border-muted)] p-3">
              <GradingConfigSummary summary={summary} /><Button onClick={() => setSelectedIndex(summary.index)}>Edit {summary.id}</Button>
            </article>)}
            <Button disabled={isBlocked} onClick={() => { edit([], [...draft.definitions, {}]); setSelectedIndex(draft.definitions.length); }}>Add definition</Button>
          </aside>
          <div className="min-w-0 grid content-start gap-3">
            {selectedIndex !== null && draft.definitions[selectedIndex] !== undefined ? <>
              <h2>Definition {selectedIndex + 1} · shared draft section</h2>
              <Button variant="danger" disabled={isBlocked} onClick={() => { edit([], draft.definitions.filter((_, index) => index !== selectedIndex)); setSelectedIndex(0); }}>Remove definition</Button>
              <GradingDefinitionEditor definition={draft.definitions[selectedIndex]} index={selectedIndex} catalogue={read.catalogue} issues={issues} onEdit={(path, value) => { if (!hasJsonErrors(jsonInputs)) edit([selectedIndex, ...path], value); }} jsonField={jsonField} />
            </> : <p>Select or add a definition to edit the shared draft.</p>}
          </div>
        </div>}
      </fieldset>
      <details><summary>Latest published definitions</summary>{definitionSummaries(publishedDefinitions(read.latest)).map((summary) => <GradingConfigSummary key={summary.index} summary={summary} />)}</details>
      <div className="flex flex-wrap gap-2">{read.versions.versions.map((item) => <Button key={item.version} disabled={isBusy} onClick={() => requestRestore(item.version)}>Initialize draft from version {item.version}</Button>)}</div>
    </>}
    {restoreVersion !== null && <div role="alertdialog" aria-label="Replace unsaved draft" className="grid gap-3 rounded border border-[var(--border-muted)] p-4">
      <p>Replace unsaved local edits with version {restoreVersion}? This saves that version as the shared draft.</p>
      <div className="flex gap-2"><Button variant="danger" onClick={() => void initialize(restoreVersion)}>Replace draft</Button><Button onClick={() => setRestoreVersion(null)}>Keep editing</Button></div>
    </div>}
  </div>;
}
