/**
 * The `accept` list for a file input that takes a written document.
 *
 * kbbl has two of these — the spec sidebar's notes upload and the new run's
 * brief — and they answer the same question: what counts as something a person
 * wrote for an agent to read. Held once because two copies of an accept list
 * drift the moment one of them learns about a new format, and the symptom is a
 * file the operator can attach in one place and not the other, with nothing
 * saying why.
 *
 * Plain text only. Formats needing extraction (pdf, docx) are absent because
 * nothing here extracts them — a file input that accepts what the reader cannot
 * read produces an empty document rather than an error.
 */
export const TEXT_DOCUMENT_FILE_ACCEPT =
  ".md,.txt,.json,.yaml,.yml,.csv,.adoc,.rst,text/plain,text/markdown,application/json";
