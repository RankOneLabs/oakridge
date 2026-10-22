# DBOS recovery version

Oakridge normally derives `DBOS.applicationVersion` from the workflow core WASM digest, the authority storage baseline, and `ENGINE_SOURCE_MANIFEST`. A process resumes only DBOS workflows recorded under its own application version. Tests that kill and restart the server mid-run must therefore restart with the same WASM and source manifest to exercise ordinary recovery.

Set `DBOS_APPLICATION_VERSION` to a stable, explicit value when an in-flight run must resume across a deployment whose derived digest changes. Deploy the compatible runtime under that value, let its pending workflows recover, and remove the override only after those workflows have settled. An override changes DBOS workflow ownership; it does not make an incompatible schema or workflow implementation safe.
