import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Checks only the offline prerequisite guard. No tool grants are simulated and
// the live grant test stays skipped in all three cases.
test.each([
  ["neither credential", "", ""],
  ["only builder credential", "guard-only-builder", ""],
  ["only assessor credential", "", "guard-only-assessor"],
])("the live smoke import makes no network requests with %s", async (_label, builder, assessor) => {
  const directory = await mkdtemp(join(tmpdir(), "gated-review-guard-"));
  try {
    const preload = join(directory, "offline.ts");
    await writeFile(preload, `globalThis.fetch = async () => {
      console.error("UNEXPECTED_LIVE_PROBE"); throw new Error("network is forbidden in this guard test");
    };`);
    const env: NodeJS.ProcessEnv = { ...process.env, GATED_REVIEW_BUILDER_TOKEN: builder, GATED_REVIEW_ASSESSOR_TOKEN: assessor };
    delete env.BUN_INSPECT;
    const child = Bun.spawn([process.execPath, "test", "--preload", preload,
      join(import.meta.dir, "gated-review-tools.smoke.test.ts")], { env, stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(),
      new Response(child.stderr).text(), child.exited]);
    const output = stdout + stderr;
    expect(code).toBe(0);
    expect(output).toContain("SKIP: gated-review live tools/list; missing");
    expect(output).toContain("1 skip");
    expect(output).not.toContain("UNEXPECTED_LIVE_PROBE");
  } finally { await rm(directory, { recursive: true, force: true }); }
});
