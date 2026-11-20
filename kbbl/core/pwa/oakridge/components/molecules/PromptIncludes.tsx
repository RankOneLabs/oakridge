import { Button } from "../../../components/atoms/Button";
/** The shared prompts a prompt includes, each opening its own editor. */
export function PromptIncludes({ includes, onEditPrompt }: { includes: readonly string[]; onEditPrompt?: (path: string) => void }) {
  if (includes.length === 0) return null;
  return <><h5>Includes</h5><ul>{includes.map(include => <li key={include}>{include}{" "}
    <Button disabled={!onEditPrompt} aria-label={`Edit ${include}`} onClick={() => onEditPrompt?.(include)}>Edit included prompt</Button></li>)}</ul></>;
}
