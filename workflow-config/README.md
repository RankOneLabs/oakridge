# Workflow configuration

The v2 examples are authored in `samples/review-loop.yaml` and
`samples/fan-out.yaml`. `bun workflow-config/src/generate.ts` parses those YAML
files with the workspace's `yaml` package and writes their JSON counterparts to
`workflow-core/fixtures/bundles/`, which the Rust compiler and replay tests use.
Run `bun workflow-config/src/generate.ts --check` to detect drift; CI runs this
check. The prompts referenced by the samples live under `prompts/review-loop/`
and `prompts/fan-out/`, and the Rust sample tests load those exact files.

The DBOS and PWA v1 tests still need local development bundles during the
cutover. `bun workflow-config/src/generate.ts --pwa-fixtures` produces those
ignored test inputs. They are not part of the v2 sample compiler path.
