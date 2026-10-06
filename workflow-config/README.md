# Workflow configuration

`definitions/development.json` is the canonical generic development bundle.
`definitions/development-independent-siblings.json` continues independent work
after a child failure and changes the shared implementation capacity to two.

The behavior contract is in `definitions/development-contract.md`. Prompts under
`prompts/dev-flow/` receive pinned action inputs and selected publication authority
from the runtime. The old v15 prompts remain historical source references; no
runtime or editor loads the retired v15 definition.
