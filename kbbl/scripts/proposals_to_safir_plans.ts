#!/usr/bin/env bun
/**
 * One-shot migration: reads proposal JSON files from a kbbl proposals dir,
 * posts each as a safir plan, then renames the dir to "<dir>.migrated".
 *
 * Idempotent: skips files that have already been migrated (detected by the
 * .migrated suffix on the directory) and ignores safir 409 conflicts (plan
 * already exists for that parent task).
 *
 * Usage:
 *   bun kbbl/scripts/proposals_to_safir_plans.ts <proposals-dir>
 *
 * Env:
 *   SAFIR_BASE_URL   — defaults to http://localhost:7145
 *   SAFIR_API_TOKEN  — optional bearer token
 */
import { access, readdir, readFile, rename } from "node:fs/promises";
import { join } from "node:path";

const rawDir = process.argv[2];
if (!rawDir) {
  console.error("usage: bun proposals_to_safir_plans.ts <proposals-dir>");
  process.exit(1);
}

const proposalsDir = rawDir.replace(/\/+$/, "");

if (proposalsDir.endsWith(".migrated")) {
  console.log("directory already has .migrated suffix — nothing to do");
  process.exit(0);
}

// If source dir is gone but <dir>.migrated exists, a previous run succeeded.
const migratedDest = `${proposalsDir}.migrated`;
const alreadyMigrated = await access(migratedDest).then(() => true).catch(() => false);
if (alreadyMigrated) {
  console.log(`${migratedDest} already exists — nothing to do`);
  process.exit(0);
}

const safirBase = (process.env.SAFIR_BASE_URL ?? "http://localhost:7145").replace(/\/+$/, "");
const token = process.env.SAFIR_API_TOKEN ?? null;

function headers(): Record<string, string> {
  const h: Record<string, string> = { "content-type": "application/json" };
  if (token) h["authorization"] = `Bearer ${token}`;
  return h;
}

interface ProposalTask {
  index: number;
  title: string;
  notes: string;
  priority: number;
}

interface ProposalDep {
  task_index: number;
  depends_on_index: number;
}

interface OldProposal {
  id: string;
  parent_task_id: number;
  tasks: ProposalTask[];
  dependencies: ProposalDep[];
  summary: string;
  model: string;
  status: string;
}

let migrated = 0;
let skipped = 0;
let failed = 0;

const files = (await readdir(proposalsDir)).filter((f) => f.endsWith(".json"));
console.log(`found ${files.length} proposal files in ${proposalsDir}`);

for (const file of files) {
  let raw: string;
  try {
    raw = await readFile(join(proposalsDir, file), "utf8");
  } catch (e) {
    console.error(`  fail ${file}: read error: ${e}`);
    failed++;
    continue;
  }
  let proposal: OldProposal;
  try {
    proposal = JSON.parse(raw) as OldProposal;
  } catch (e) {
    console.error(`  fail ${file}: parse error: ${e}`);
    failed++;
    continue;
  }

  if (proposal.status !== "pending") {
    console.log(`  skip ${file}: status=${proposal.status}`);
    skipped++;
    continue;
  }

  const payload = {
    summary: proposal.summary,
    model: proposal.model,
    cohorts: proposal.tasks.map((t) => ({
      cohort_index: t.index,
      title: t.title,
      notes: t.notes,
      priority: t.priority,
    })),
    dependencies: proposal.dependencies.map((d) => ({
      cohort_index: d.task_index,
      depends_on_cohort_index: d.depends_on_index,
    })),
  };

  const url = `${safirBase}/tasks/${proposal.parent_task_id}/plans`;
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify(payload),
    });
  } catch (e) {
    console.error(`  fail ${file}: network error: ${e}`);
    failed++;
    continue;
  }

  if (res.status === 409) {
    console.log(`  skip ${file}: 409 conflict (plan already exists for parent ${proposal.parent_task_id})`);
    skipped++;
    continue;
  }

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    console.error(`  fail ${file}: HTTP ${res.status} — ${body}`);
    failed++;
    continue;
  }

  const created = (await res.json()) as { id: string };
  console.log(`  migrated ${file} → plan ${created.id}`);
  migrated++;
}

console.log(`\ndone: ${migrated} migrated, ${skipped} skipped, ${failed} failed`);

if (failed === 0) {
  const dest = `${proposalsDir}.migrated`;
  await rename(proposalsDir, dest);
  console.log(`renamed ${proposalsDir} → ${dest}`);
} else {
  console.error(`${failed} failures — directory not renamed`);
  process.exit(1);
}
