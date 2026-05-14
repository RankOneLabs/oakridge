# agent-dev-flow: operator guide

## Running a build from a safir task

```bash
safir-build <task_id>
```

By default this runs planner-2, produces a build brief in `pending_approval`
state, prints `Brief ready for review: <id>. Next: …`, and exits. The build
does **not** run automatically — review the brief in the kbbl PWA first.

After approving:
- Click **Run build** in the PWA, or
- Run `safir-build --from-brief <brief_id>` from the CLI.

To skip the review gate and run planner-2 + build agent in one go:

```bash
safir-build <task_id> --auto-approve
```

To run planner-2 only without creating a build phase (legacy dry-run):

```bash
safir-build <task_id> --dry-run
```

`--from-brief` and `--auto-approve` are mutually exclusive; `--from-brief`
already requires an approved brief.
