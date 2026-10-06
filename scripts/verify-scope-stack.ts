import { resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
interface VerificationStep { readonly label: string; readonly command: readonly string[]; readonly cwd: string }
const steps: readonly VerificationStep[] = [
  { label: "Rust CLI build", command: ["cargo", "build", "--locked", "-p", "workflow-cli"], cwd: resolve(root, "workflow-core") },
  { label: "Workspace typecheck", command: ["bun", "run", "typecheck"], cwd: root },
  { label: "Scope authority tests, including PostgreSQL and cold boot", command: ["bun", "run", "test:unit"], cwd: resolve(root, "oakridge-dbos") },
];
if (!process.env.OAKRIDGE_TEST_DATABASE_URL) {
  console.error("Verification requires OAKRIDGE_TEST_DATABASE_URL pointing to a test PostgreSQL server with CREATE DATABASE permission.");
  process.exit(1);
}
for (const step of steps) {
  console.info(`Verify: ${step.label}`);
  const child = Bun.spawn([...step.command], { cwd: step.cwd, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
  const status = await child.exited;
  if (status !== 0) process.exit(status);
}
