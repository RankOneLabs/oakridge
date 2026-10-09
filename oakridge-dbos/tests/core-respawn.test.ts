import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { CoreClient } from "../src/core-client/client";
import { CORE_PROTOCOL_VERSION, type DefinitionBundle } from "../src/core-client/generated-contracts";

test("a later request reopens a client after replacement spawn fails", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "oakridge-respawn-"));
  const script = resolve(directory, "child.sh");
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  writeFileSync(script, '#!/bin/sh\nrm -- "$0"\nIFS= read -r line\necho unavailable >&2\nexit 1\n');
  chmodSync(script, 0o700);
  const started = CoreClient.start({ binary: script, deadlineMs: 10_000 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  const client = started.value;
  try {
    const first = client.request("compile", { bundle });
    const survivor = client.request("compile", { bundle: { ...bundle, key: "survivor" } });
    expect(await first).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    expect(await survivor).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    expect(client.health.last_stderr_lines).toContain("unavailable");
    writeFileSync(script, `#!/bin/sh\nIFS= read -r line\nprintf '%s\\n' '{"version":${CORE_PROTOCOL_VERSION},"request_id":"3","truncated":false,"result":{"status":"ok","value":{"kind":"compiled","value":{"digest":"ready","scopes":[]}}}}'\n`);
    chmodSync(script, 0o700);
    expect(await client.request("compile", { bundle: { ...bundle, key: "later" } }))
      .toMatchObject({ ok: true, value: { kind: "compiled" } });
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
});

test("a pending request that fails on every respawn is replayed a bounded number of times, not forever", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "oakridge-respawn-bound-"));
  const script = resolve(directory, "child.sh");
  const bundle: DefinitionBundle = await Bun.file(resolve(import.meta.dir, "../../workflow-core/fixtures/bundles/minimal.json")).json();
  // Reads one line and dies every single time: every respawn replays the same poisoned request.
  writeFileSync(script, "#!/bin/sh\nIFS= read -r line\nexit 1\n");
  chmodSync(script, 0o700);
  const started = CoreClient.start({ binary: script, deadlineMs: 10_000 });
  if (!started.ok) throw new Error(started.error.detail.detail);
  const client = started.value;
  try {
    const result = await client.request("compile", { bundle });
    expect(result).toMatchObject({ ok: false, error: { kind: "transport", detail: { kind: "terminated_child" } } });
    // A script that fails every time must not loop across respawns forever; the bound keeps it small.
    expect(client.health.restart_count).toBeLessThan(20);
  } finally {
    client.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 30_000);
