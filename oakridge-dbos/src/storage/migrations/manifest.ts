export interface MigrationEntry { readonly name: string; readonly file: URL }

export const migrations: readonly MigrationEntry[] = [
  { name: "0001_core.sql", file: new URL("./0001_core.sql", import.meta.url) },
  { name: "0002_historical_runs.sql", file: new URL("./0002_historical_runs.sql", import.meta.url) },
];
