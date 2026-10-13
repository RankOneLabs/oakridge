/**
 * The PWA port gate (rescue spec R6). The Oakridge PWA keeps the look it had at
 * 9b12e34c and reads only the v2 operator contract:
 *
 * - every `data-testid` the module rendered at the baseline still exists;
 * - the global stylesheet is unchanged from the baseline;
 * - no v1 contract vocabulary is left in the module's code or tests.
 *
 * Test ids are compared, not markup: the components may read different data,
 * but the surfaces the browser tests and the operator rely on stay.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, readdirSync } from "node:fs";
import { relative, resolve } from "node:path";

const BASELINE = "9b12e34c";
const root = resolve(import.meta.dir, "../..");
const MODULE = "kbbl/core/pwa/oakridge";
const STYLESHEET = "kbbl/core/pwa/styles.css";
/** Files outside the module that read the operator contract. */
const CONTRACT_READERS = ["kbbl/core/pwa/lib/hash.ts", "kbbl/core/pwa/lib/session.ts", "kbbl/core/pwa/views/SessionListView.tsx"];
/** Generated from the backend and the core; their own generators keep them current. */
const GENERATED = new Set([`${MODULE}/operator-contracts.ts`, `${MODULE}/workflow-definition-types.ts`]);

/** v1 operator-contract names and shapes with no place in the v2 PWA. */
const V1_VOCABULARY: readonly RegExp[] = [
  /\bscope_(?:id|key|version)\b/, /\bscopes\b/, /\bscopeId\b/, /\bScope[A-Z]\w*/, /\w+Scope\w*/, /\/scopes\//,
  /\bCheckedValue\b/, /\bselectChecked\w*/, /\bOperatorCommand\w*/, /\bcommand(?:s|_key|_targets|_prefill)\b/, /\bavailable_commands\b/,
  /\bexecution(?:s|_id)\b/, /\bExecution\w*View\b/, /\btransition(?:s|_id)\b/, /\bauthoring\b/i,
  /\bcurrent_revision(?:_id)?\b/, /\boutput_key\b/, /\bslot_version\b/, /\bowner_version\b/, /\bedit_trigger\b/,
  /\bconsequence\b/, /\bdecision_(?:targets|prefill)\b/,
];
/** Test ids whose surface went with a v1 feature that has no v2 source. */
const RETIRED_TEST_IDS: Readonly<Record<string, string>> = {
  "operator-pending-evidence": "v1 decision prefill: a v2 decision carries its target revision in `submit`",
  "operator-prefilled-field": "v1 decision prefill: a v2 decision carries its target revision in `submit`",
  "or-role-settings": "launch-time planner and worker settings: a v2 workflow sets each worker's runtime",
};
/** Test ids may keep their v1 words; they are the browser tests' and the operator's handles. */
const ALLOWED = [/(?:data-testid|testId)=(?:"[^"]*"|\{`[^`]*`\})/g, /getByTestId\("[^"]*"\)/g];

const git = (...args: readonly string[]): string => execFileSync("git", args, { cwd: root, encoding: "utf8" });
const isSource = (path: string): boolean => /\.tsx?$/.test(path);
const isTest = (path: string): boolean => /\.test\.tsx?$/.test(path) || path.includes("/__tests__/");

function moduleFiles(): readonly string[] {
  return readdirSync(resolve(root, MODULE), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, resolve(entry.parentPath, entry.name)));
}

const TEST_ID = /(?:data-testid|testId)=(?:"([^"]+)"|\{`([^`]+)`\})/g;
export const testIds = (source: string): readonly string[] =>
  [...source.matchAll(TEST_ID)].map((match) => match[1] ?? match[2]!);

/** Each line of `source` that still speaks the v1 contract. */
export function v1Vocabulary(source: string): readonly string[] {
  return source.split("\n").flatMap((line, index) => {
    const scrubbed = ALLOWED.reduce((text, pattern) => text.replace(pattern, ""), line);
    const hit = V1_VOCABULARY.find((pattern) => pattern.test(scrubbed));
    return hit ? [`${index + 1}: ${line.trim()} (${hit.source})`] : [];
  });
}

export function checkPort(): readonly string[] {
  const failures: string[] = [];
  const baseline = git("ls-tree", "-r", "--name-only", BASELINE, `${MODULE}/`).split("\n").filter((path) => isSource(path) && !isTest(path));
  const current = moduleFiles().filter(isSource);
  const currentIds = new Set(current.filter((path) => !isTest(path)).flatMap((path) => testIds(readFileSync(resolve(root, path), "utf8"))));
  for (const path of baseline)
    for (const id of testIds(git("show", `${BASELINE}:${path}`)))
      if (!currentIds.has(id) && !(id in RETIRED_TEST_IDS)) failures.push(`data-testid "${id}" (in ${path} at ${BASELINE}) no longer exists`);
  if (git("diff", "--name-only", BASELINE, "--", STYLESHEET).trim() !== "" || git("status", "--porcelain", "--", STYLESHEET).trim() !== "")
    failures.push(`${STYLESHEET} differs from ${BASELINE}; the port keeps the look`);
  for (const path of [...current.filter((file) => !GENERATED.has(file)), ...CONTRACT_READERS])
    for (const hit of v1Vocabulary(readFileSync(resolve(root, path), "utf8"))) failures.push(`${path}:${hit}`);
  return failures;
}

if (import.meta.main) {
  const failures = checkPort();
  for (const failure of failures) console.error(`check-pwa-port: ${failure}`);
  if (failures.length > 0) process.exit(1);
  console.log("check-pwa-port: the PWA keeps its baseline test ids and stylesheet and reads only the v2 contract");
}
