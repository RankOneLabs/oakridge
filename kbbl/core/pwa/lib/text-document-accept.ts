/**
 * The `accept` list for a file input that takes a written document.
 *
 * Used by the new run's brief upload for documents an agent can read.
 *
 * Plain text only. Formats needing extraction (pdf, docx) are absent because
 * nothing here extracts them — a file input that accepts what the reader cannot
 * read produces an empty document rather than an error.
 */
export const TEXT_DOCUMENT_FILE_ACCEPT =
  ".md,.txt,.json,.yaml,.yml,.csv,.adoc,.rst,text/plain,text/markdown,application/json";
