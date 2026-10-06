import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { fetchOperatorDefinitions, launchOperatorRun } from "../client";
import { Button } from "../../components/atoms/Button";

interface Props { readonly onBack: () => void; readonly onCreated: (runId: string) => void; readonly onEdit: () => void }
export function OperatorLaunchView({ onBack, onCreated, onEdit }: Props) {
  const definitions = useQuery({ queryKey: ["operator", "definitions"], queryFn: fetchOperatorDefinitions });
  const [digest, setDigest] = useState("");
  const [input, setInput] = useState("{}");
  const [error, setError] = useState<string | null>(null);
  const [launching, setLaunching] = useState(false);
  const selected = digest || definitions.data?.[0]?.digest || "";
  const launch = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    let parsed: unknown;
    try { parsed = JSON.parse(input); } catch (cause) { setError(String(cause)); return; }
    setLaunching(true);
    try { const run = await launchOperatorRun(selected, parsed); onCreated(run.run_id); }
    catch (cause) { setError(String(cause)); }
    finally { setLaunching(false); }
  };
  return <main className="or-page" data-testid="or-new-run">
    <header className="or-page-header"><Button variant="secondary" onClick={onBack}>Back</Button><h1 className="or-page-title">Launch pinned run</h1></header>
    {definitions.isError && <p role="alert">{String(definitions.error)}</p>}
    {definitions.data?.length === 0 && <p>No pinned definition yet. <Button onClick={onEdit}>Edit definition</Button></p>}
    <form onSubmit={(event) => void launch(event)}>
      <label htmlFor="operator-digest">Definition digest</label>
      <select id="operator-digest" value={selected} onChange={(event) => setDigest(event.target.value)}>
        {definitions.data?.map((item) => <option key={item.digest} value={item.digest}>{item.source.key} v{item.source.version} · {item.digest}</option>)}
      </select>
      <label htmlFor="operator-input">Root input JSON</label>
      <textarea id="operator-input" value={input} onChange={(event) => setInput(event.target.value)} className="w-full min-h-48 rounded-md border p-3 font-mono text-xs" />
      {error && <p role="alert">{error}</p>}
      <Button type="submit" disabled={!selected || launching}>Launch</Button>
    </form>
  </main>;
}
