/**
 * Minimal responder subprocess.
 *
 * Invoked as:
 *   bun run <path>/run.ts \
 *     --responder=<id> \
 *     --thread-id=<id> \
 *     --target-type=<type> \
 *     --target-id=<id> \
 *     --kbbl-url=<url>
 *
 * Reads the thread's anchor and current messages, posts a generic
 * acknowledgement message, and exits. v1 body is intentionally a
 * stand-in — real responder logic is deferred to cohort 6 dogfooding.
 */

import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    responder: { type: "string" },
    "thread-id": { type: "string" },
    "target-type": { type: "string" },
    "target-id": { type: "string" },
    "kbbl-url": { type: "string" },
  },
});

const responderId = values.responder ?? "(unknown)";
const threadId = values["thread-id"];
const targetType = values["target-type"];
const targetId = values["target-id"];
const kbblUrl = values["kbbl-url"];

if (!threadId || !kbblUrl) {
  console.error("responder/run: --thread-id and --kbbl-url are required");
  process.exit(1);
}

async function main() {
  // Fetch the thread to get the anchor.
  let anchor: string | null = null;
  try {
    const res = await fetch(`${kbblUrl}/threads/${encodeURIComponent(threadId!)}`);
    if (res.ok) {
      const thread = (await res.json()) as { anchor?: string | null };
      anchor = thread.anchor ?? null;
    }
  } catch {
    // Non-fatal — post with generic body if thread fetch fails.
  }

  // Fetch the latest atom value for the anchor if available.
  let liveValue = "(see the artifact)";
  if (anchor && targetType && targetId) {
    try {
      const res = await fetch(
        `${kbblUrl}/atoms?target_type=${encodeURIComponent(targetType)}&target_id=${encodeURIComponent(targetId!)}`,
      );
      if (res.ok) {
        const atoms = (await res.json()) as { anchor: string; new_value: string }[];
        const match = atoms.findLast((a) => a.anchor === anchor);
        if (match) liveValue = match.new_value;
      }
    } catch {
      // Non-fatal.
    }
  }

  const anchorLabel = anchor ?? "(no anchor)";
  const body = `(automated responder: ${responderId}) I see comments on \`${anchorLabel}\`; current live value is: ${liveValue}`;

  try {
    const res = await fetch(`${kbblUrl}/threads/${encodeURIComponent(threadId!)}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body, author: responderId }),
    });
    if (!res.ok) {
      console.error(`responder/run: POST /threads/${threadId}/messages failed: ${res.status}`);
      process.exit(1);
    }
  } catch (err) {
    console.error(`responder/run: failed to post message: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  }
}

await main();
