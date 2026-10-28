# Observation

`observation/` is the provisional name for an independently deployable service package. A directory rename changes only this directory and the three root workspace entries: `package.json` workspaces, `package.json` typecheck, and `tsconfig.json` references. Its dependency list and types belong to this package; it does not import `oakridge-dbos` or `kbbl`.

Canonical JSON v1 identities are computed from the canonicalized body recovered from JSONB. Byte-identical recovery of a producer's submitted JSON is not claimed.

For credentials, startup, retention, upgrades and recovery, see
[observation operations](../docs/observation-operations.md). The checked-in
`fixtures/oakridge/run-slice/` corpus drives the cross-layer slice and failure
cases. Run `bun test observation/tests` with a local PostgreSQL server named by
`OAKRIDGE_TEST_DATABASE_URL`; the tests create and remove isolated databases.
They do not contact Langfuse, a model provider or Assay.

## Canonical JSON v1

The canonicalizer emits UTF-8 JSON with no insignificant whitespace. Object keys are sorted by UTF-16 code unit; array order is retained. Strings use JSON string escaping. Finite integers within JavaScript's safe-integer range use the shortest base-10 decimal without an exponent or signed zero. Non-integers use the shortest plain decimal that round-trips within **15 significant decimal digits**, obtained from `toPrecision(15)` by removing trailing zeroes and expanding any exponent. A non-integer that cannot round-trip that representation is refused. NaN, infinity, unsafe integers, undefined, cycles, sparse arrays and non-JSON objects are refused. Digests are SHA-256 over these UTF-8 bytes and carry the tag `canonical-json/v1:<sha256 hex>`.
