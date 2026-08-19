import type { ChangeEvent } from "react";

import { BRIEF_NOTES_FILE_ACCEPT, type BriefNotesSource } from "../../lib/brief-notes";
import { formControlClass } from "./FormField";
import { Button } from "../atoms/Button";

interface BriefNotesFieldProps {
  notes: string;
  setNotes: (notes: string) => void;
  source: BriefNotesSource;
  setSource: (source: BriefNotesSource) => void;
  onFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  disabled: boolean;
}

/**
 * The operating brief, typed or loaded from a file.
 *
 * A fieldset rather than FormField's label, because the source toggle is a pair
 * of buttons: nested in a label, a click on one also activates the labelled
 * control.
 *
 * Reading the file is the organism's job — it is IO and it can fail, and this
 * only surfaces the input.
 */
export function BriefNotesField({ notes, setNotes, source, setSource, onFileChange, disabled }: BriefNotesFieldProps) {
  return (
    <fieldset className="flex flex-col gap-1">
      <legend className="mb-1 flex w-full items-center justify-between gap-3">
        <span className="text-xs font-medium text-[var(--text-muted)]">Brief Notes</span>
        <span role="group" aria-label="Brief notes source" className="flex gap-1">
          <Button
            size="small"
            variant={source.kind === "typed" ? "primary" : "secondary"}
            aria-pressed={source.kind === "typed"}
            disabled={disabled}
            // Switching back keeps whatever a loaded file put there, so this is
            // how an operator edits an uploaded brief — not how they lose it.
            onClick={() => setSource({ kind: "typed" })}
          >
            Write
          </Button>
          <Button
            size="small"
            variant={source.kind === "file" ? "primary" : "secondary"}
            aria-pressed={source.kind === "file"}
            disabled={disabled}
            onClick={() => setSource({ kind: "file", file_name: "" })}
          >
            Upload file
          </Button>
        </span>
      </legend>

      {source.kind === "typed" ? (
        <textarea
          className={`${formControlClass} min-h-24 resize-y`}
          value={notes}
          onChange={(event) => setNotes(event.target.value)}
          disabled={disabled}
          placeholder="Describe what to build…"
          required
          rows={4}
          aria-label="Brief notes"
        />
      ) : (
        <div className="flex flex-col gap-2">
          <input
            type="file"
            className={`${formControlClass} file:mr-3 file:rounded file:border-0 file:bg-[var(--bg-raised)] file:px-2 file:py-1 file:text-xs file:text-[var(--text-primary)]`}
            accept={BRIEF_NOTES_FILE_ACCEPT}
            onChange={onFileChange}
            disabled={disabled}
            aria-label="Brief notes file"
          />
          {source.file_name !== "" && (
            <p className="text-xs text-[var(--text-muted)]">
              Loaded <span className="font-medium text-[var(--text-primary)]">{source.file_name}</span>
              {" — "}{notes.length.toLocaleString()} characters. Switch to Write to edit before starting.
            </p>
          )}
          {/*
            Read-only rather than absent: an operator about to spend a run on
            this text should be able to see they picked the file they meant.
          */}
          <textarea
            className={`${formControlClass} min-h-24 resize-y`}
            value={notes}
            readOnly
            placeholder="The file's contents appear here."
            rows={4}
            aria-label="Brief notes preview"
          />
          <p className="text-xs text-[var(--text-muted)]">
            Markdown, text, or another plain-text document. Its contents become the brief.
          </p>
        </div>
      )}
    </fieldset>
  );
}
