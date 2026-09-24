// The per-run accent colour.
//
// An enumerated palette rather than a computed colour, because there is no
// third option under the project's styling rules: Tailwind cannot generate a
// class from a runtime value, and inline style objects are forbidden. Eight
// fixed `or-run-accent--N` classes live in `styles.css`, each setting a single
// `--or-run-accent` custom property that components read through
// `text-[var(--or-run-accent)]` / `border-[var(--or-run-accent)]`.
//
// Selection is a pure hash of the run id, so the same run wears the same colour
// on every render, in every tab, and after a reload — nothing is stored and
// nothing is random.

export const RUN_ACCENT_CLASSES = [
  "or-run-accent--0",
  "or-run-accent--1",
  "or-run-accent--2",
  "or-run-accent--3",
  "or-run-accent--4",
  "or-run-accent--5",
  "or-run-accent--6",
  "or-run-accent--7",
] as const;

export type RunAccentClass = (typeof RUN_ACCENT_CLASSES)[number];

const FNV_OFFSET_BASIS = 0x811c9dc5;
const FNV_PRIME = 0x01000193;

/**
 * FNV-1a over the run id's UTF-16 code units, as an unsigned 32-bit value.
 *
 * `Math.imul` keeps the multiply in 32-bit space — a plain `*` overflows into
 * float territory past 2^53 and starts losing the low bits the hash is built
 * from, which would make the result depend on how long the id happens to be.
 */
const hashRunId = (runId: string): number => {
  let hash = FNV_OFFSET_BASIS;
  for (let index = 0; index < runId.length; index += 1) {
    hash ^= runId.charCodeAt(index);
    hash = Math.imul(hash, FNV_PRIME);
  }
  return hash >>> 0;
};

/** The one palette class this run wears, everywhere, always. */
export const selectRunAccentClass = (runId: string): RunAccentClass =>
  RUN_ACCENT_CLASSES[hashRunId(runId) % RUN_ACCENT_CLASSES.length];
