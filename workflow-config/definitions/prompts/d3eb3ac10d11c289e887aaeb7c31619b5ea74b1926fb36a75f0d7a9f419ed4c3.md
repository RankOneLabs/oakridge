## Paid runner host

Run paid cohorts on otto in `~/apps/{{repository_name}}`, where the evaluator Docker runtime and study store live. Use concurrency one. Before claiming a launch, run `docker ps` and wait for any qualification containers to finish. Keep CPU-heavy fixture generation, qualification, and Docker builds off this host.
