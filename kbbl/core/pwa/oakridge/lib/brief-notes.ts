import type { Result } from "../../lib/result";

/**
 * Where the brief notes on a new run came from.
 *
 * The run's contract does not change with this: `brief_notes` is a string
 * either way, forwarded verbatim to `spec_analyzer`. A file is a way to supply
 * that string without pasting it, not a second kind of brief — so the source is
 * a property of the form, and never leaves it.
 */
export type BriefNotesSource =
  /** Typed into the textarea. */
  | { readonly kind: "typed" }
  /** Read off disk. The name is kept so the form can say which file it holds. */
  | { readonly kind: "file"; readonly file_name: string };

export interface BriefNotesFileError {
  readonly operation: "read_brief_notes_file";
  readonly detail: string;
}

/**
 * Brief notes end up in an agent's prompt, so a file picked by accident — a
 * video, a database dump — costs more than a rejected upload. Generous enough
 * that no real brief reaches it: a very long spec is tens of kilobytes.
 */
export const MAX_BRIEF_NOTES_BYTES = 1_048_576;

/** What a browser hands us on a file input, narrowed to what the guard reads. */
export interface SelectedFile {
  readonly name: string;
  readonly size: number;
}

/**
 * Why a file cannot be used as brief notes, or null when it can.
 *
 * Checked before reading rather than after, because size is known from the
 * handle alone and reading a large file into memory to then reject it is the
 * cost the limit exists to avoid.
 */
export const selectBriefNotesFileRefusal = (file: SelectedFile): BriefNotesFileError | null => {
  if (file.size === 0) {
    return { operation: "read_brief_notes_file", detail: `${file.name} is empty.` };
  }
  if (file.size > MAX_BRIEF_NOTES_BYTES) {
    return {
      operation: "read_brief_notes_file",
      detail: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_BRIEF_NOTES_BYTES)} limit for brief notes.`,
    };
  }
  return null;
};

/**
 * Whether loaded text is usable as brief notes.
 *
 * A file of only whitespace passes the size guard and would fail the form's own
 * required check afterwards with a message about the textarea, which is not
 * where the operator just put their attention.
 */
export const selectLoadedBriefNotesRefusal = (
  file: SelectedFile,
  text: string,
): BriefNotesFileError | null =>
  text.trim() === ""
    ? { operation: "read_brief_notes_file", detail: `${file.name} has no readable text.` }
    : null;

/** Bytes as an operator would say them, for a message they have to act on. */
export const formatBytes = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`;

/**
 * The file input's `accept` list. Text formats a brief is actually written in —
 * the same set the spec upload already offers, so the two file pickers do not
 * disagree about what counts as a document.
 */
export const BRIEF_NOTES_FILE_ACCEPT =
  ".md,.txt,.json,.yaml,.yml,.csv,.adoc,.rst,text/plain,text/markdown,application/json";

/** A file's text, guarded on both sides of the read. */
export interface LoadedBriefNotes {
  readonly text: string;
  readonly file_name: string;
}

/**
 * Reads brief notes off a picked file.
 *
 * The IO boundary for this feature: `file.text()` is the only thing here that
 * can throw, so it is caught and converted, and every caller upstream deals in
 * `Result`.
 */
export const readBriefNotesFile = async (
  file: SelectedFile & { text(): Promise<string> },
): Promise<Result<LoadedBriefNotes, BriefNotesFileError>> => {
  const refusal = selectBriefNotesFileRefusal(file);
  if (refusal) return { ok: false, error: refusal };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: { operation: "read_brief_notes_file", detail: `Could not read ${file.name}.` } };
  }
  const loadedRefusal = selectLoadedBriefNotesRefusal(file, text);
  if (loadedRefusal) return { ok: false, error: loadedRefusal };
  return { ok: true, value: { text, file_name: file.name } };
};

/**
 * What to tell an operator who submitted with no brief notes.
 *
 * The generic "Brief notes are required" reads as a broken form when the
 * operator is looking at a file picker they have not used yet.
 */
export const selectMissingBriefNotesDetail = (source: BriefNotesSource): string =>
  source.kind === "file" ? "Choose a file with the brief notes." : "Brief notes are required.";
