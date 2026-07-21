import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Database } from "bun:sqlite";
import { openTestDb } from "../../db/test-db";
import { insertProject } from "../../db/projects";
import { insertSpec } from "../../db/specs";
import { insertEpic } from "../../db/epics";
import { taskTrackerEvents } from "../../db/events";
import { createDispatcher } from "../backends/dispatcher";
import { wireDispatchHooks } from "../dispatch-hooks";
import type { ExecutionBackend, InputRef, StageRow } from "../backends/interface";
import type { RuntimeModelSelection } from "../../runtime";

interface DispatchCall {
  stageName: string;
  inputType: string;
  inputId: string;
  modelSelection: RuntimeModelSelection;
}

interface MockBackend extends ExecutionBackend {
  calls: DispatchCall[];
}

function createMockBackend(): MockBackend {
  const calls: DispatchCall[] = [];
  return {
    id: "kbbl_chat",
    calls,
    async dispatch(stage: StageRow, inputRef: InputRef) {
      calls.push({
        stageName: stage.name,
        inputType: inputRef.type,
        inputId: inputRef.id,
        modelSelection: inputRef.modelSelection,
      });
      return { session_ref: `mock-${calls.length}` };
    },
    async status(_session_ref: string) {
      return "completed" as const;
    },
  };
}

function flushAsync() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

const PROJECT_ID = "proj-1";
const SPEC_ID = "spec-1";
const EPIC_ID = "epic-1";

let db: Database;
let mockBackend: MockBackend;
let cleanupHooks: () => void;
let promptsDir: string;
const origPromptsDir = process.env.KBBL_PROMPTS_DIR;

beforeEach(() => {
  promptsDir = mkdtempSync(join(tmpdir(), "kbbl-dispatch-hooks-test-"));
  writeFileSync(
    join(promptsDir, "spec_analyzer.md"),
    "spec_analyzer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}",
    "utf8",
  );
  writeFileSync(
    join(promptsDir, "plan_writer.md"),
    "plan_writer {{SPEC_ID}} {{SPEC_TITLE}} {{SPEC_NOTES}} {{REPO_PATH}} {{KBBL_URL}}",
    "utf8",
  );
  process.env.KBBL_PROMPTS_DIR = promptsDir;

  db = openTestDb();
  insertProject(db, { id: PROJECT_ID, name: "P", repo_path: "/tmp/repo" });
  insertSpec(db, { id: SPEC_ID, project_id: PROJECT_ID, title: "My Spec" });
  insertEpic(db, {
    id: EPIC_ID,
    spec_id: SPEC_ID,
    project_id: PROJECT_ID,
    title: "My Spec",
    status: "active",
    current_stage: "spec",
    planner_model_selection: { runtime: "claude-code", model: "claude-opus-4-8" },
    worker_model_selection: { runtime: "codex", model: "gpt-5.6-luna" },
  });

  mockBackend = createMockBackend();
  const dispatcher = createDispatcher({
    db,
    backends: { kbbl_chat: mockBackend },
    kbblUrl: "http://localhost:8788",
  });
  cleanupHooks = wireDispatchHooks({ taskTrackerEvents, dispatcher, db });
});

afterEach(() => {
  cleanupHooks();
  db.close();
  if (origPromptsDir === undefined) {
    delete process.env.KBBL_PROMPTS_DIR;
  } else {
    process.env.KBBL_PROMPTS_DIR = origPromptsDir;
  }
});

describe("dispatch hooks rewire", () => {
  test("spec.created fires spec_analyzer (not plan_writer)", async () => {
    taskTrackerEvents.emit("spec.created", { spec_id: SPEC_ID });
    await flushAsync();

    expect(mockBackend.calls).toHaveLength(1);
    expect(mockBackend.calls[0]!.stageName).toBe("spec_analyzer");
    expect(mockBackend.calls[0]!.inputId).toBe(SPEC_ID);
    expect(mockBackend.calls[0]!.inputType).toBe("spec");
    expect(mockBackend.calls[0]!.modelSelection).toEqual({
      runtime: "claude-code",
      model: "claude-opus-4-8",
      effort: null,
    });
  });

  test("spec.created does not fire plan_writer", async () => {
    taskTrackerEvents.emit("spec.created", { spec_id: SPEC_ID });
    await flushAsync();

    const planWriterCalls = mockBackend.calls.filter((c) => c.stageName === "plan_writer");
    expect(planWriterCalls).toHaveLength(0);
  });

  test("spec.approved fires plan_writer", async () => {
    taskTrackerEvents.emit("spec.approved", { spec_id: SPEC_ID, epic_id: EPIC_ID });
    await flushAsync();

    expect(mockBackend.calls).toHaveLength(1);
    expect(mockBackend.calls[0]!.stageName).toBe("plan_writer");
    expect(mockBackend.calls[0]!.inputId).toBe(SPEC_ID);
    expect(mockBackend.calls[0]!.inputType).toBe("spec");
    expect(mockBackend.calls[0]!.modelSelection).toEqual({
      runtime: "claude-code",
      model: "claude-opus-4-8",
      effort: null,
    });
  });

  test("spec.approved does not fire spec_analyzer", async () => {
    taskTrackerEvents.emit("spec.approved", { spec_id: SPEC_ID, epic_id: EPIC_ID });
    await flushAsync();

    const specAnalyzerCalls = mockBackend.calls.filter((c) => c.stageName === "spec_analyzer");
    expect(specAnalyzerCalls).toHaveLength(0);
  });

  test("spec.created and spec.approved each fire their own stage exactly once", async () => {
    taskTrackerEvents.emit("spec.created", { spec_id: SPEC_ID });
    await flushAsync();
    taskTrackerEvents.emit("spec.approved", { spec_id: SPEC_ID, epic_id: EPIC_ID });
    await flushAsync();

    expect(mockBackend.calls).toHaveLength(2);
    expect(mockBackend.calls[0]!.stageName).toBe("spec_analyzer");
    expect(mockBackend.calls[1]!.stageName).toBe("plan_writer");
  });
});
