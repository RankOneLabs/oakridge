import type { Schema } from "../source-contracts";
import { primitivesSchemas } from "./schemas/primitives";
import { repositoriesSchemas } from "./schemas/repositories";
import { analysisSchemas } from "./schemas/analysis";
import { planningSchemas } from "./schemas/planning";
import { briefsSchemas } from "./schemas/briefs";
import { implementationSchemas } from "./schemas/implementation";
import { reviewSchemas } from "./schemas/review";
import { executionSchemas } from "./schemas/execution";
import { runSchemas } from "./schemas/run";
import { forgeSchemas } from "./schemas/forge";

/** Declaration order is part of the pinned source digest. */
export const developmentSchemas: Schema[] = [
  ...primitivesSchemas,
  ...repositoriesSchemas,
  ...analysisSchemas,
  ...planningSchemas,
  ...briefsSchemas,
  ...implementationSchemas,
  ...reviewSchemas,
  ...executionSchemas,
  ...runSchemas,
  ...forgeSchemas,
];
