## Hosts

- Do not run CPU-heavy commands on otto (fixture generation, qualification, docker builds, test suites over the generated fixtures). Use mcclure for that work.
- Run every paid cohort of this study, including the pilot, on otto, where the evaluator Docker runtime and study store live. Never move a cohort to another machine.
- Before launching any paid cohort, run `docker ps` on otto. Wait for any qualification containers to finish and check again before launching. Never launch beside them. Use concurrency one.
