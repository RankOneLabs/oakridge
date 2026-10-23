# Active known issues

Reproducible issues in the Rust evaluator, DBOS authority, provider composition
and operator PWA. Record the affected version or bundle, a reproduction, and the
observed and expected behavior. Remove an entry once its fix is verified.

## Development workflow

- **A PR artifact can claim a PR with an empty URL.** `pr_body.pr_url` is plain
  `text`, so a builder that cannot reach the forge can publish `pr_url: ""`.
  `pr_watch` then starts and fails `invalid_instruction`, because
  `pull_request.observe` requires a nonempty URL. Expected: the artifact is
  rejected, so an absent PR neither starts observation nor reads as published.

## Executor

- **The backend publication key is readable by same-user agent processes.**
  `scripts/oakridge-shadow` keeps it beside the agent workdir and runs the
  backend and agents under one OS account. The loopback publish route requires
  an explicit operator intent and a session bearer, which prevents accidental
  misattribution, but isolating the key needs a separate process or account.

## Frozen v1 operator UI on v2

- **A decision retried after a remount can be duplicated.** `GateDecisionActions`
  keeps its ingress `request_id` in a per-mount `useRef`, so a remount after an
  uncertain response sends a new id that does not deduplicate the original.
  Fixing it needs a frozen-UI exemption.
- **No pull request mismatch rows.** v2 `pull_request.observe` reports a state
  but no v1 `PullRequestMismatch` facts, so the inbox never emits
  `pull_request_mismatch` and that UI stays inactive.
- **The feedback form submits one field.** Development decisions with two
  fields, or one field other than `feedback`, are refused by the adapter rather
  than dropping data. Current `request_changes` decisions use only `feedback`.
- **Controls with no v2 command fail explicitly:** thread ping and resolution,
  review-item updates, run deletion (v2 has `DELETE /runs/:run_id`; Cancel and
  Archive were chosen instead), and saving a v1 workflow graph. The definition
  detail shows a placeholder graph and creation date.
- **`confirmFinalPullRequest` returns a placeholder `EpicWorkflowProfile`** to
  satisfy its v1 signature; the committed decision is the authority.
- **Activity shows only events with a v1 equivalent.** There are no
  `gate_opened` or `pull_request_observed` rows. Each refresh reads every unit's
  history; measure on long runs before shortening the poll interval.
- **A retired v1 artifact or gate UUID resolves to not-found.** Only composite
  v2 ids and v2 revision ids resolve.
