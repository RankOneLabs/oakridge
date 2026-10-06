import type canonicalDefinition from "../../../../workflow-config/definitions/development.json";
/** The editor mirrors the canonical source; semantic validation belongs to the core. */
export type WorkflowDefinitionDescriptor = typeof canonicalDefinition;
