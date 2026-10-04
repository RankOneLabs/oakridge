import { createHash } from "node:crypto";
import type { WorkOrderId } from "../domain/primitives";

export const capabilityFor = (seed: string, workOrderId: WorkOrderId): string => createHash("sha256").update(seed).update(":").update(workOrderId).digest("base64url");
export const capabilityHash = (capability: string): string => createHash("sha256").update(capability).digest("hex");
