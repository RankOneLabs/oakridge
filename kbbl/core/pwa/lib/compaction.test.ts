import { describe, expect, it } from "vitest";

import { shouldSuggestCompaction } from "./compaction";

const compactCommand = [{ name: "compact", description: "Compact context" }];

describe("shouldSuggestCompaction", () => {
  it("suggests an advertised compact command at the configured threshold", () => {
    expect(
      shouldSuggestCompaction({
        usage: { used: 30_000, size: 200_000, cost: null },
        softThresholdTokens: 30_000,
        commands: compactCommand,
        isDismissed: false,
      }),
    ).toBe(true);
  });

  it("does not offer an unsupported command", () => {
    expect(
      shouldSuggestCompaction({
        usage: { used: 100_000, size: 200_000, cost: null },
        softThresholdTokens: 30_000,
        commands: [],
        isDismissed: false,
      }),
    ).toBe(false);
  });

  it("honors dismissal until the caller resets it", () => {
    expect(
      shouldSuggestCompaction({
        usage: { used: 100_000, size: 200_000, cost: null },
        softThresholdTokens: 30_000,
        commands: compactCommand,
        isDismissed: true,
      }),
    ).toBe(false);
  });
});
