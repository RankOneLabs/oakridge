import { describe, expect, test } from "bun:test";
import { buildSafirBacklogPromptBlock } from "./safir-backlog-prompt";

const BASE = "http://localhost:7145";

describe("buildSafirBacklogPromptBlock", () => {
  test("returns null when taskId is undefined", () => {
    expect(
      buildSafirBacklogPromptBlock({
        taskId: undefined,
        projectId: "r1l",
        sid: "sess-abc",
        safirBaseUrl: BASE,
      }),
    ).toBeNull();
  });

  test("returns null when projectId is undefined (lookup failed)", () => {
    expect(
      buildSafirBacklogPromptBlock({
        taskId: 42,
        projectId: undefined,
        sid: "sess-abc",
        safirBaseUrl: BASE,
      }),
    ).toBeNull();
  });

  test("interpolates taskId, projectId, sid when all set", () => {
    const block = buildSafirBacklogPromptBlock({
      taskId: 42,
      projectId: "r1l",
      sid: "sess-xyz",
      safirBaseUrl: BASE,
    });
    expect(block).not.toBeNull();
    expect(block!).toContain("safir task #42");
    expect(block!).toContain("project `r1l`");
    expect(block!).toContain("kbbl session sess-xyz");
    expect(block!).toContain('"project_id":"r1l"');
    expect(block!).toContain('"parent_id":42');
    expect(block!).toContain('"status":"backlog"');
  });

  test("opens with the SAFIR BACKLOG INTEGRATION header", () => {
    const block = buildSafirBacklogPromptBlock({
      taskId: 1,
      projectId: "p",
      sid: "s",
      safirBaseUrl: BASE,
    })!;
    expect(block.startsWith("## SAFIR BACKLOG INTEGRATION\n")).toBe(true);
  });

  test("contains exactly one curl invocation (POST only)", () => {
    const block = buildSafirBacklogPromptBlock({
      taskId: 7,
      projectId: "p",
      sid: "s",
      safirBaseUrl: BASE,
    })!;
    const curlMatches = block.match(/curl /g) ?? [];
    expect(curlMatches.length).toBe(1);
    expect(block).toContain(`curl -s -X POST ${BASE}/tasks`);
  });

  test("uses the supplied safirBaseUrl literal in the curl line", () => {
    const block = buildSafirBacklogPromptBlock({
      taskId: 7,
      projectId: "p",
      sid: "s",
      safirBaseUrl: "http://safir.tail-abc.ts.net:7145",
    })!;
    expect(block).toContain(
      "curl -s -X POST http://safir.tail-abc.ts.net:7145/tasks",
    );
  });
});
