import type { Schema } from "../../source-contracts";
import { field, recordSchema } from "../../primitives/schemas";

export const repositoriesSchemas: Schema[] = [
  recordSchema("session_config", [field("runtime", "runtime"), field("workdir", "repo_path"), field("session_name", "ident")]),
  recordSchema("repo_input", [field("repository_path", "repo_path"), field("expected_head", "optional_text")]),
  recordSchema("repo_result", [field("repository_path", "repo_path"), field("push_remote_owner", "ident"), field("head", "ident")]),
  { key: "repository_refs", shape: { kind: "list", item: "repo_result", max_items: 100 } },
  recordSchema("repository_config", [
    field("key", "ident"),
    field("preparation", "repo_input"),
    field("build", "session_config"),
    field("integration", "session_config"),
    field("forge", "forge_config")
  ]),
  { key: "repository_configs", shape: { kind: "list", item: "repository_config", max_items: 100 } },
];
