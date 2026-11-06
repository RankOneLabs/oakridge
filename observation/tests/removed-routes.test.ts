import { expect, test } from "bun:test";
import { createApp } from "../src/http/app";
import type { Database } from "../src/storage/database";

const app = createApp({ db: {} as Database, credentials: { ingest: [], read: [] } });
const routes: readonly (readonly [string, string])[] = [
  ["GET", "/v1/sources/oakridge/human-grades"], ["POST", "/v1/sources/oakridge/operator-events"],
  ["GET", "/v1/sources/oakridge/operator-cursor"], ["GET", "/v1/sources/oakridge/backfill"],
  ["POST", "/v1/sources/oakridge/backfill"], ["GET", "/v1/sources/oakridge/collaboration-comments"],
  ["POST", "/v1/sources/oakridge/sync"], ["POST", "/v1/exports/assay"],
  ["GET", "/v1/blind-assignments"], ["POST", "/v1/blind-assignments"],
  ["GET", "/v1/blind-assignments/id"], ["POST", "/v1/blind-assignments/id/claim"],
  ["POST", "/v1/blind-assignments/id/submit"], ["GET", "/v1/evaluation-eligibility"],
  ["GET", "/v1/runs/run-1/coverage"], ["POST", "/v1/evaluations"], ["POST", "/v1/grades"],
  ["POST", "/v1/evaluation-jobs"], ["GET", "/v1/evaluation-jobs/id"], ["GET", "/v1/items/id/evaluation-jobs"],
  ["GET", "/v1/evaluations/by-digest/digest"], ["GET", "/v1/evaluation-executions/id"],
  ["POST", "/v1/evaluation-executions/id/recover"],
];
test("removed capture, grading, operator, backfill and export routes return 404 without credentials", async () => {
  const responses = await Promise.all(routes.map(async ([method, path]) => ({ method, path, status: (await app.request(path, { method })).status })));
  expect(responses).toEqual(routes.map(([method, path]) => ({ method, path, status: 404 })));
});
