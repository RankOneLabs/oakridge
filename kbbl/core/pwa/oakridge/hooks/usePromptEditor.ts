import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { fetchOperatorDefinition } from "../client";
import { savePendingPrompt, validatePendingPrompt, publishPrompt } from "../client-prompt-versions";
import { createPromptDraft, editPromptBody, pendingSaved, discardLocalEdits, promptPublished, selectPublishedDefinitionId, type PromptFeedback } from "../lib/prompt-editor";
import type { OperatorDefinitionDetail } from "../operator-contracts/projections/definition-view";
import type { OperatorPromptVersionListing } from "../operator-contracts/http/prompt-versions";
import type { DefinitionSelection } from "../../lib/hash";
import { definitionSelectionHref, definitionTabHref } from "../lib/definition-selection";
import { useGradingNavigationGuard } from "./useGradingNavigationGuard";
interface PromptEditorOptions {
  path: string; definition: OperatorDefinitionDetail; versions: OperatorPromptVersionListing;
  selection: DefinitionSelection | null; onClose: () => void;
}
export function usePromptEditor({path, definition, versions, selection, onClose}: PromptEditorOptions) {
  const queryClient = useQueryClient();
  const [state, setState] = useState(() => createPromptDraft({path, published: definition.prompts[path], versions}));
  const [feedback, setFeedback] = useState<PromptFeedback | null>(null);
  const [is_busy, setBusy] = useState(false);
  const [publishedId, setPublishedId] = useState(versions.published.version_id);
  const isMounted = useRef(false);
  const navigationEpoch = useRef(0);
  useEffect(() => {
    isMounted.current = true;
    const onNavigation = () => { navigationEpoch.current += 1; };
    window.addEventListener("hashchange", onNavigation);
    return () => { isMounted.current = false; window.removeEventListener("hashchange", onNavigation); };
  }, []);
  useEffect(() => {
    if (state.is_dirty || is_busy) return;
    setState(createPromptDraft({path, published: {body: versions.published.body, digest: versions.published.version_id}, versions}));
    setPublishedId(versions.published.version_id);
  }, [versions, path, state.is_dirty, is_busy]);
  useGradingNavigationGuard(state.is_dirty);
  async function save() {
    setBusy(true); setFeedback({kind: "saving"});
    const result = await savePendingPrompt({path, body: state.body, expected: state.pending?.digest ?? null});
    if (result.ok) {
      setState(pendingSaved(state, result.value)); setFeedback({kind: "saved", digest: result.value.version_id});
      await queryClient.invalidateQueries({queryKey: ["oakridge", "prompt-versions", path]});
    } else setFeedback(result.feedback);
    setBusy(false);
  }
  async function validate() {
    if (!state.pending) return;
    setBusy(true); setFeedback({kind: "validating"});
    const result = await validatePendingPrompt(path, state.pending.digest);
    setFeedback(result.ok ? {kind: "validated"} : result.feedback); setBusy(false);
  }
  async function publish() {
    if (!state.pending) return;
    const originHref = window.location.href;
    const originEpoch = navigationEpoch.current;
    setBusy(true); setFeedback({kind: "publishing"});
    const result = await publishPrompt({path, expected: {expected_pending_version_id: state.pending.digest, expected_published_version_id: publishedId}});
    if (!result.ok) {setFeedback(result.feedback); setBusy(false); return;}
    const id = selectPublishedDefinitionId(result.value, definition.bundle.key);
    setState(promptPublished(state, result.value.version_id)); setPublishedId(result.value.version_id);
    setFeedback({kind: "published", definition_id: id});
    await Promise.all([
      queryClient.invalidateQueries({queryKey: ["oakridge", "prompt-versions", path]}),
      queryClient.invalidateQueries({queryKey: ["oakridge", "workflow_defs"]}),
      queryClient.invalidateQueries({queryKey: ["oakridge", "workflow_def"]}),
    ]);
    if (id) {
      await queryClient.prefetchQuery({queryKey: ["oakridge", "workflow_def", id], queryFn: () => fetchOperatorDefinition(id)});
      if (isMounted.current && window.location.href === originHref && navigationEpoch.current === originEpoch) {
        window.location.hash = selection ? definitionTabHref(id, selection, "prompts") : definitionSelectionHref(id, null);
      }
    }
    setBusy(false);
  }
  function close() {
    onClose();
  }
  return {state, feedback, is_busy, save, validate, publish, close,
    edit: (body: string) => setState(current => editPromptBody(current, body)),
    discard: () => setState(discardLocalEdits)};
}
