# V2 to frozen v1 mapping contracts

The source contract is `../operator-contracts.ts`; the target is `../types.ts`.
These pairs are fixed before implementing the transforms:

| Transform | Typed input | Typed output |
| --- | --- | --- |
| Run snapshot | `OperatorRunView` and `readonly OperatorUnitView[]` | `RunDetail` (and its `RunSummary` projection) |
| Unit to stage grouping | `readonly OperatorUnitView[]` | `StageDetail[]` |
| Review to gate | `OperatorUnitView` and its `OperatorDecisionDefinition[]` | `ParkedGate[]` |
| Revision to artifact | `OperatorArtifactDetail` | `ArtifactDetail` and `ArtifactTypeDescriptor` |
| Attempt to work order | `OperatorAttemptView` and `OperatorUnitView` | `RunSessionAttempt` |
| Run event kind | `OperatorRunEvent` | `RunEventFrame | null` |
| Status derivation | `OperatorUnitStatus`, `OperatorAttention`, attempts and run stalls | `RunStatus` and `StageStatus` |
| Development inbox classification | `OperatorRunInboxBatchEntry` and `readonly OperatorUnitView[]` | `ReviewInboxItem[]` and `CohortLifecycleSummary[]` |

The final transform is deliberately specific to the development workflow. Its
closed v1 lifecycle and inbox variants do not describe arbitrary v2 workflows.
