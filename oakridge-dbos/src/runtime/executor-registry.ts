import type { ExecutorAdapter } from "../domain/execution";

const adapters = new Map<string, ExecutorAdapter>();

export const findExecutorAdapter = (executor_type: string): ExecutorAdapter | undefined => adapters.get(executor_type);

export const registerExecutorAdapter = (adapter: ExecutorAdapter): void => {
  if (adapters.has(adapter.executor_type)) throw new Error(`executor adapter '${adapter.executor_type}' is already registered`);
  adapters.set(adapter.executor_type, adapter);
};

/** Adapter role registration is descriptive; v15 trees own progression. */
export class AdapterRegistry {
  private readonly roles = new Set<string>();
  register_role(name: string): void {
    if (name.trim().length === 0) throw new Error("adapter role name must be non-empty");
    if (this.roles.has(name)) throw new Error(`adapter role '${name}' is already registered`);
    this.roles.add(name);
  }
  has_role(name: string): boolean { return this.roles.has(name); }
}

export interface AdapterRoleRegistry { has_role(name: string): boolean }
