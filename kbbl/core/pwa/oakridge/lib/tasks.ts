import type { Result } from "../../lib/result";

/** Mirrors `task` in workflow-config/development.yaml. */
export interface Task {
  id: string;
  description: string;
  requirement_ids: string[];
}

/** Mirrors `tasks_body` in workflow-config/development.yaml. */
export interface Tasks {
  tasks: Task[];
}

export interface TasksParseError {
  operation: "parse_tasks";
  field: string;
  detail: string;
}

type Parsed<T> = Result<T, TasksParseError>;

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const fail = (field: string, detail: string): Parsed<never> => ({ ok: false, error: { operation: "parse_tasks", field, detail } });

function isRecord(value: unknown): value is { [key: string]: unknown } {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Matches the core evaluator's `is_ident` rule, counting Unicode characters. */
function isIdent(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && [...value].length <= 100 && !/[\p{Cc}/\\]/u.test(value);
}

function parseTask(value: unknown, field: string): Parsed<Task> {
  if (!isRecord(value)) return fail(field, "expected an object");
  if (!isIdent(value.id)) return fail(`${field}.id`, "expected an ident");
  if (typeof value.description !== "string") return fail(`${field}.description`, "expected a string");
  if (!Array.isArray(value.requirement_ids)) return fail(`${field}.requirement_ids`, "expected an array of idents");
  for (const [index, id] of value.requirement_ids.entries()) {
    if (!isIdent(id)) return fail(`${field}.requirement_ids[${index}]`, "expected an ident");
  }
  return ok({ id: value.id, description: value.description, requirement_ids: value.requirement_ids as string[] });
}

export function parseTasks(body: unknown): Parsed<Tasks> {
  if (!isRecord(body)) return fail("body", "expected an object");
  if (!Array.isArray(body.tasks)) return fail("tasks", "expected an array");
  const tasks: Task[] = [];
  const seenIds = new Set<string>();
  for (const [index, entry] of body.tasks.entries()) {
    const parsed = parseTask(entry, `tasks[${index}]`);
    if (!parsed.ok) return parsed;
    if (seenIds.has(parsed.value.id)) return fail(`tasks[${index}].id`, "duplicate task id");
    seenIds.add(parsed.value.id);
    tasks.push(parsed.value);
  }
  return ok({ tasks });
}
