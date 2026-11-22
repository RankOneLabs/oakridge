## Qualification hosts

- Qualification runs on mcclure, never otto, with at most two scenarios at once.
- Per run:
  1. Image: `docker save <evaluator image> | ssh mcclure docker load`. Then `ssh mcclure docker image inspect <evaluator image> | jq -r '.[0].Id'` must equal the pinned image digest; stop otherwise.
  2. Code: over `ssh -A mcclure`, use a dedicated checkout under `~/study-runs/<study>/<group-id>/<branch-hash>/{{repository_name}}`. Use safe directory components and compute `branch-hash` as the SHA-256 of the exact expansion branch name so simultaneous groups or study runs have distinct checkouts. Push the expansion branch before remote qualification, then clone it there or fast-forward the same branch in its existing checkout. Use its `experiments/` directory for `uv sync --locked --group dev`, regeneration, and qualification. Check the tree digest equals the builder's.
  3. Logs: beside the dedicated checkout under `~/study-runs/<study>/<group-id>/<branch-hash>/` on mcclure, never under /tmp. A wake power-cycles mcclure and wipes /tmp.
  4. Results: commit on mcclure and push back over git with the forwarded agent (`ssh -A`). Never copy fixtures or results with scp.
- A connection timeout means mcclure suspended on idle. Wake it with `POST willie:8900/machines/mcclure/wake` and poll `GET willie:8900/machines` until it leaves waking.
- mcclure shuts down only after 30 minutes with no work, so a long qualification run is safe once started.

An expansion holds one of the run's two expander slots for its whole active life, from start until it is done, including review waits; the pool limits expansions within one study run, not concurrent study runs.
