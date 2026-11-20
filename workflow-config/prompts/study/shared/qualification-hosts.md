## Qualification hosts

- Qualification runs on mcclure, never otto, with at most two scenarios at once.
- Per run:
  1. Image: `docker save <evaluator image> | ssh mcclure docker load`. Then `ssh mcclure docker image inspect <evaluator image> | jq -r '.[0].Id'` must equal the pinned image digest; stop otherwise.
  2. Code: over `ssh -A mcclure`, clone or `git pull --ff-only` the study branch into ~/apps/assay. Run `uv sync --locked --group dev` in ~/apps/assay/experiments. Regenerate, and check the tree digest equals the builder's.
  3. Logs: under ~/study-runs/<study>/ on mcclure, never under /tmp. A wake power-cycles mcclure and wipes /tmp.
  4. Results: commit on mcclure and push back over git with the forwarded agent (`ssh -A`). Never copy fixtures or results with scp.
- A connection timeout means mcclure suspended on idle. Wake it with `POST willie:8900/machines/mcclure/wake` and poll `GET willie:8900/machines` until it leaves `waking`.
- mcclure shuts down only after 30 minutes with no work, so a long qualification run is safe once started.
