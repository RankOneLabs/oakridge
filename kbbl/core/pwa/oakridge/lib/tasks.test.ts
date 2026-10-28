import { describe, expect, test } from "vitest";
import { parseTasks } from "./tasks";

const linked = { id: "task-a", description: "Build the viewer.", requirement_ids: ["req-a"] };

describe("parseTasks", () => {
  test("reads the registered tasks body and its requirement links", () => {
    expect(parseTasks({ tasks: [linked] })).toEqual({ ok: true, value: { tasks: [linked] } });
  });

  test("reads an empty requirement list as no link", () => {
    const unlinked = { ...linked, requirement_ids: [] };
    expect(parseTasks({ tasks: [unlinked] })).toEqual({ ok: true, value: { tasks: [unlinked] } });
  });

  test("rejects a repeated task id at the repeated entry", () => {
    const result = parseTasks({ tasks: [linked, linked] });
    expect(result.ok ? null : result.error).toEqual({ operation: "parse_tasks", field: "tasks[1].id", detail: "duplicate task id" });
  });

  test.each(["", "a".repeat(101), "bad\nname", "bad/name", "bad\\name"])("rejects a non-ident task id %j", (id) => {
    const result = parseTasks({ tasks: [linked, { ...linked, id }] });
    expect(result.ok ? null : result.error.field).toBe("tasks[1].id");
  });

  test("rejects an invalid requirement id at its list position", () => {
    const result = parseTasks({ tasks: [{ ...linked, requirement_ids: ["req-a", "bad/name"] }] });
    expect(result.ok ? null : result.error.field).toBe("tasks[0].requirement_ids[1]");
  });
});
