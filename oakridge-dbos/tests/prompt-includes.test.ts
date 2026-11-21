import { expect, test } from "bun:test";
import { MAX_EXPANDED_PROMPT_BYTES, expandPrompts, selectIncludes } from "../src/runtime/prompt-includes";
import { bytesIdentity, composePrompts } from "../src/runtime/definition-store";

const sources = {
  "review.md": "# Review\n\n{{> shared/adjudication.md}}\n\n## Assessment\n\n{{ assessment }}\n",
  "shared/adjudication.md": "Record a disposition. {{> shared/forwarding.md}}\n",
  "shared/forwarding.md": "Only rework_feedback is forwarded.\n",
  "unused.md": "Not read.\n",
};

test("an include is replaced by the included prompt, nested includes expanded, without its final newline", () => {
  const expanded = expandPrompts(["review.md"], sources);
  expect(expanded.ok && expanded.value.prompts["review.md"])
    .toBe("# Review\n\nRecord a disposition. Only rework_feedback is forwarded.\n\n## Assessment\n\n{{ assessment }}\n");
});
test("expansion lists every authored prompt it read, and no other", () => {
  const expanded = expandPrompts(["review.md"], sources);
  expect(expanded.ok && expanded.value.sources).toEqual(["review.md", "shared/adjudication.md", "shared/forwarding.md"]);
});
test("an include of a prompt that does not exist is refused, naming both prompts", () => {
  const expanded = expandPrompts(["review.md"], { ...sources, "shared/adjudication.md": "{{> shared/absent.md}}\n" });
  expect(!expanded.ok && expanded.error).toMatchObject({ kind: "missing_include", entity_id: "review.md", detail: "shared/adjudication.md includes shared/absent.md, which is missing" });
});
test("a prompt that includes itself, through any chain, is refused", () => {
  const expanded = expandPrompts(["review.md"], { ...sources, "shared/forwarding.md": "{{> shared/adjudication.md}}\n" });
  expect(!expanded.ok && expanded.error).toMatchObject({ kind: "include_cycle",
    detail: "prompt includes itself: review.md -> shared/adjudication.md -> shared/forwarding.md -> shared/adjudication.md" });
});
test("a prompt may include the same file twice", () => {
  const expanded = expandPrompts(["twice.md"], { "twice.md": "{{> a.md}} and {{> a.md}}\n", "a.md": "A\n" });
  expect(expanded.ok && expanded.value.prompts["twice.md"]).toBe("A and A\n");
});
test("a prompt that expands past the size limit is refused, however few files it takes", () => {
  const doubling = Object.fromEntries(Array.from({ length: 40 }, (_, level) =>
    [`level-${level}.md`, level === 0 ? "x".repeat(64) + "\n" : `{{> level-${level - 1}.md}}{{> level-${level - 1}.md}}\n`]));
  const expanded = expandPrompts(["level-39.md"], doubling);
  expect(!expanded.ok && expanded.error).toMatchObject({ kind: "expansion_too_large", entity_id: "level-39.md",
    detail: `level-14.md expands past ${MAX_EXPANDED_PROMPT_BYTES} bytes` });
});
test("a file included at every level of a deep doubling chain is expanded once", () => {
  const doubling = Object.fromEntries(Array.from({ length: 60 }, (_, level) =>
    [`level-${level}.md`, level === 0 ? "\n" : `{{> level-${level - 1}.md}}{{> level-${level - 1}.md}}\n`]));
  const expanded = expandPrompts(["level-59.md"], doubling);
  expect(expanded.ok && expanded.value.prompts["level-59.md"]).toBe("\n");
});
test("a committed prompt id covers the expanded text, and a source id the authored text", () => {
  const composed = composePrompts(["review.md"], sources);
  if (!composed.ok) throw new Error(composed.error.detail);
  expect([composed.value.prompts["review.md"].id, composed.value.prompt_sources["review.md"].id, composed.value.prompt_sources["shared/forwarding.md"].id])
    .toEqual([bytesIdentity(Buffer.from(composed.value.prompts["review.md"].text)), bytesIdentity(Buffer.from(sources["review.md"])), bytesIdentity(Buffer.from(sources["shared/forwarding.md"]))]);
});
test("editing an included prompt changes the id of every prompt that includes it", () => {
  const before = composePrompts(["review.md"], sources);
  const after = composePrompts(["review.md"], { ...sources, "shared/forwarding.md": "Only rework_feedback reaches the builder.\n" });
  expect(before.ok && after.ok && before.value.prompts["review.md"].id !== after.value.prompts["review.md"].id).toBe(true);
});
test("a prompt's direct includes are listed once each, in the order the text first names them", () => {
  expect(selectIncludes("{{> b.md}} {{ input }} {{>a.md}} {{> b.md}}\n")).toEqual(["b.md", "a.md"]);
});
