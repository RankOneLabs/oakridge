import { ARTIFACT_KEY_LIST } from "../artifact-versions";
import { register } from "../extractor-helpers";

export const registrations = ARTIFACT_KEY_LIST.filter((key) => key.workflow === "review-loop").map((key) => register(key, []));
