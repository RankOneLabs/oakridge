import type { DecisionTree, WorkflowDefinitionDescriptor as DefinitionBundle, Expression, OperationManifest, Prompt, Schema, ScopeDefinition } from "./source-contracts";

/** These authoring constructors are checked against Rust's generated source contract. */
export const defineBundle = (value: DefinitionBundle): DefinitionBundle => value;
export const definePrompt = (value: Prompt): Prompt => value;
export const defineSchema = (value: Schema): Schema => value;
export const defineScope = (value: ScopeDefinition): ScopeDefinition => value;
export const defineOperation = (value: OperationManifest): OperationManifest => value;
export const defineExpression = (value: Expression): Expression => value;
export const defineDecision = (value: DecisionTree): DecisionTree => value;
