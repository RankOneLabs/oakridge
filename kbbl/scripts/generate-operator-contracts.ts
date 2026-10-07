import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import ts from "typescript";

const root = resolve(import.meta.dir, "../..");
const output = resolve(root, "kbbl/core/pwa/oakridge/operator-contracts.ts");

function projection(path: string, names: readonly string[]): string {
  const source = readFileSync(resolve(root, path), "utf8");
  const file = ts.createSourceFile(path, source, ts.ScriptTarget.Latest, true);
  return names.map((name) => {
    const declaration = file.statements.find((statement) =>
      (ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)) && statement.name.text === name);
    if (!declaration) throw new Error(`${path}: ${name} projection missing`);
    return declaration.getText(file);
  }).join("\n\n");
}

const run = projection("oakridge-dbos/src/projections/run-view.ts", ["RunScopeSummary", "RunView"])
  .replaceAll("RunScopeSummary", "OperatorRunScopeSummary")
  .replaceAll("RunView", "OperatorRunView")
  .replaceAll("RunId", "string");
const catalog = projection("oakridge-dbos/src/projections/run-view.ts", ["OperatorDefinitionSummary"])
  .replaceAll('import("../core-client/generated-contracts").DefinitionBundle', 'import("./workflow-definition-types").WorkflowDefinitionDescriptor');
const operatorScope = projection("oakridge-dbos/src/projections/scope-view.ts", [
  "OperatorResourceBinding", "OperatorSchemaShape", "OperatorSchemaField", "OperatorSchema",
  "OperatorPresentation", "OperatorCommandDescriptor", "OperatorScopeDefinition", "OperatorPinnedDefinition",
  "OperatorGenericRun", "OperatorCheckedValue", "OperatorCheckedData", "OperatorTargetRevision",
  "OperatorArtifactRevision", "OperatorOutputSlot", "OperatorScopeView", "OperatorDraftKey",
  "OperatorCommandSubmission", "OperatorCommandReceipt",
]);
const operatorInbox = projection("oakridge-dbos/src/projections/inbox.ts", ["OperatorInboxItem", "OperatorInbox", "OperatorInboxPage"]);
const scope = projection("oakridge-dbos/src/projections/scope-view.ts", ["ProjectionCursor", "ScopeView"])
  .replaceAll("ProjectionCursor", "OperatorProjectionCursor")
  .replaceAll("ScopeView", "OperatorScopeProjection")
  .replaceAll("ScopeId", "string")
  .replaceAll("CheckedValue", "OperatorCheckedValue")
  .replaceAll("CommandDefinition", "OperatorCommandDescriptor")
  .replaceAll("ExecutionRecord", 'OperatorScopeView["executions"][number]')
  .replaceAll("OutputSlotView", "OperatorOutputSlot")
  .replaceAll("ResourceBindingRecord", "OperatorResourceBinding")
  .replaceAll("TargetRevision", "OperatorTargetRevision")
  .replaceAll("DecisionOutcome", "unknown");
const history = projection("oakridge-dbos/src/http/diagnostics.ts", ["ScopeFactHistory", "ScopeHistory"])
  .replaceAll("ScopeFactHistory", "OperatorScopeFactHistory")
  .replaceAll("ScopeHistory", "OperatorScopeHistory")
  .replaceAll('import("../core-client/generated-contracts").CheckedValue', "OperatorCheckedValue")
  .replaceAll("TransitionHistory<Date>", "OperatorTransitionHistory");
const transition = projection("oakridge-dbos/src/projections/record-selectors.ts", ["StoredTransitionHistory", "TransitionHistory"])
  .replace(/\bStoredTransitionHistory\b/g, "OperatorStoredTransitionHistory")
  .replace(/\bTransitionHistory\b/g, "OperatorTransitionHistory")
  .replaceAll('import("../core-client/generated-contracts").DecisionOutcome', "unknown")
  .replaceAll("SqlVersion", "number | string")
  .replace(/(interface Operator(?:Stored)?TransitionHistory)<Timestamp>/g, "$1<Timestamp = string>");

const launch = projection("oakridge-dbos/src/storage/mutation-service.ts", ["StartPinnedRunRequest", "StartedRun"])
  .replaceAll("StartPinnedRunRequest", "OperatorLaunchRequest").replaceAll("StartedRun", "OperatorLaunchedRun")
  .replaceAll("RunId", "string").replaceAll("ScopeId", "string");

const generated = `// Generated from oakridge-dbos projections. Run kbbl/scripts/generate-operator-contracts.ts.\n`
  + `// The PWA intentionally imports no backend source at runtime or typecheck time.\n`
  + `${launch}\n\n${run}\n\n${catalog}\n\n${operatorScope}\n\n${operatorInbox}\n\n${scope}\n\n${transition}\n\n${history}\n`;

if (process.argv.includes("--check")) {
  if (readFileSync(output, "utf8") !== generated) throw new Error("operator-contracts.ts has drifted; run bun kbbl/scripts/generate-operator-contracts.ts");
} else writeFileSync(output, generated);
