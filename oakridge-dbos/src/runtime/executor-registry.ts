import type { ExecutorAdapter } from "../domain/execution";

const adapters = new Map<string, ExecutorAdapter>();

export const findExecutorAdapter = (executor_type: string): ExecutorAdapter | undefined => adapters.get(executor_type);

export const registerExecutorAdapter = (adapter: ExecutorAdapter): void => {
  if (adapters.has(adapter.executor_type)) throw new Error(`executor adapter '${adapter.executor_type}' is already registered`);
  adapters.set(adapter.executor_type, adapter);
};
