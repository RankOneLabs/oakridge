# Workflow configuration

`definitions/development.json` is an example pinned scope bundle.
`definitions/development-independent-siblings.json` illustrates independent
sibling work after a child failure and a shared implementation capacity of two.
The bundle declares workflow names, commands, stages, review paths and output
contracts. The Rust interpreter evaluates those declarations without branching
on a workflow name.

`definitions/development-contract.md` documents the example bundle. Prompts
under `prompts/dev-flow/` receive pinned action inputs and selected publication
authority from the runtime. Earlier v15 prompts are historical source material;
they do not govern the current implementation.
