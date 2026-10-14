import type { Result } from "../../lib/result";

export interface SpecFileError {
  readonly operation: "read_spec_file";
  readonly detail: string;
}

/**
 * A spec ends up in an agent's prompt, so a file picked by accident — a
 * video, a database dump — costs more than a rejected upload. Generous enough
 * that no real spec reaches it: a very long one is tens of kilobytes.
 */
export const MAX_SPEC_FILE_BYTES = 1_048_576;

/** What a browser hands us on a file input, narrowed to what the guard reads. */
export interface SelectedFile {
  readonly name: string;
  readonly size: number;
}

/**
 * Why a file cannot be used as a spec, or null when it can.
 *
 * Checked before reading rather than after, because size is known from the
 * handle alone and reading a large file into memory to then reject it is the
 * cost the limit exists to avoid.
 */
export const selectSpecFileRefusal = (file: SelectedFile): SpecFileError | null => {
  if (file.size === 0) {
    return { operation: "read_spec_file", detail: `${file.name} is empty.` };
  }
  if (file.size > MAX_SPEC_FILE_BYTES) {
    return {
      operation: "read_spec_file",
      detail: `${file.name} is ${formatBytes(file.size)}, over the ${formatBytes(MAX_SPEC_FILE_BYTES)} limit for a spec.`,
    };
  }
  return null;
};

/**
 * Whether loaded text is usable as a spec.
 *
 * A file of only whitespace passes the size guard and would fail the form's own
 * required check afterwards with a message about the textarea, which is not
 * where the operator just put their attention.
 */
export const selectLoadedSpecRefusal = (
  file: SelectedFile,
  text: string,
): SpecFileError | null =>
  text.trim() === ""
    ? { operation: "read_spec_file", detail: `${file.name} has no readable text.` }
    : null;

/** Bytes as an operator would say them, for a message they have to act on. */
export const formatBytes = (bytes: number): string =>
  bytes >= 1_048_576 ? `${(bytes / 1_048_576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1_024))} KB`;

/** A file's text, guarded on both sides of the read. */
export interface LoadedSpecFile {
  readonly text: string;
  readonly file_name: string;
}

/**
 * Reads a spec off a picked file.
 *
 * The IO boundary for this feature: `file.text()` is the only thing here that
 * can throw, so it is caught and converted, and every caller upstream deals in
 * `Result`.
 */
export const readSpecFile = async (
  file: SelectedFile & { text(): Promise<string> },
): Promise<Result<LoadedSpecFile, SpecFileError>> => {
  const refusal = selectSpecFileRefusal(file);
  if (refusal) return { ok: false, error: refusal };
  let text: string;
  try {
    text = await file.text();
  } catch {
    return { ok: false, error: { operation: "read_spec_file", detail: `Could not read ${file.name}.` } };
  }
  const loadedRefusal = selectLoadedSpecRefusal(file, text);
  if (loadedRefusal) return { ok: false, error: loadedRefusal };
  return { ok: true, value: { text, file_name: file.name } };
};
