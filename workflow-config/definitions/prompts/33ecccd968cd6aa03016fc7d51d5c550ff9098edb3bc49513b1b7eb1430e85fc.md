# Review slice report

Read the assessment's findings and the report's criterion and trigger marks first. Choose one of these decisions.

- **Expand** (approve with the adjudication payload for the slice assessment). Give every next action a disposition and drop every rework action before approving. The generator digest in the slice build becomes fixed for every expansion unit, and expansion starts.
- **Send actions to builder** (request changes on the slice build with the adjudication payload). The kept, edited and added rework actions reach the worker that reworks this artifact (the slice builder) as `rework_feedback`. The builder fixes fixtures or tests and qualifies the slice again. Any rebuild resets paid validation. A new spend request needs your approval before another paid run.
- **Send to builder** (request changes on the slice build with free-text feedback). Submit the feedback directly. The builder fixes fixtures or tests and qualifies the slice again. Any rebuild resets paid validation. A new spend request needs your approval before another paid run.
- **Change design** (request changes on the plan). The designer revises the plan. After you approve it, the whole slice runs again, including a new spend request and a new paid run.

## Study plan

{{plan}}

## Slice build

{{slice_build}}

## Paid slice report

{{slice_report}}

## Slice assessment

{{slice_assessment}}
