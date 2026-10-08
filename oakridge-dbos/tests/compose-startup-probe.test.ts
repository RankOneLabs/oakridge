import { expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createProductionComposition } from "../src/runtime/compose";

test("a core binary reporting an incompatible protocol version fails startup before touching the database", async () => {
  const directory = mkdtempSync(resolve(tmpdir(), "oakridge-startup-probe-"));
  const script = resolve(directory, "child.sh");
  // Every respawn attempt is a fresh process: read one request line, reply once
  // with a stale protocol version, then exit. CoreClient respawns the same
  // script up to its attempt limit, so one read-and-reply is all a single
  // invocation needs.
  writeFileSync(script, '#!/bin/sh\nIFS= read -r line\nprintf \'%s\\n\' \'{"version":3,"request_id":"1","truncated":false,"result":{"status":"ok","value":{"kind":"compiled","value":{"digest":"x","scopes":[]}}}}\'\n');
  chmodSync(script, 0o700);
  try {
    await expect(createProductionComposition({ database_url: "postgres://unreachable:5432/none", core_binary: script, host: "127.0.0.1" }))
      .rejects.toThrow(/startup protocol probe/);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}, 10_000);
