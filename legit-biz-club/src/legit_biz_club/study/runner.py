"""Study runner — drives one cell of the study end-to-end.

Given a :class:`TargetConfig` and a :class:`ConditionConfig`, builds
the agents, project, mediator, and proposers, then runs a
:class:`ProjectCoordinator`. Captures the final artifact, the run
result, and a small bag of project metrics for downstream
aggregation.

For v1, cells run sequentially. Parallel execution via jig's
``sweep`` is a v2 candidate once we have data on per-cell cost and
operator-burden patterns.

The :func:`run_cell` API takes a ``proposer_factory`` callable so
callers can plug in either real :class:`JigProposer` instances (for
the actual study) or deterministic stubs (for tests). The runner
itself is LLM-agnostic.
"""
from __future__ import annotations

import logging
import shutil
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePath

from jig.core.types import Grader, Score, TracingLogger
from jig.tracing.stdout import StdoutTracer

from legit_biz_club.coordination.consensus import WorkspaceEventEmitter
from legit_biz_club.coordination.coordinator import IncrementalRunResult
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.project_coordinator import (
    ProjectCoordinator,
    ProjectRunResult,
)
from legit_biz_club.coordination.proposal import ProposalResult
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.core.models import (
    Agent,
    Artifact,
    Enrollment,
    Project,
)
from legit_biz_club.study.conditions import ConditionConfig
from legit_biz_club.study.targets import TargetConfig

logger = logging.getLogger(__name__)


ProposerFactory = Callable[[Agent], Proposer]
"""Build a :class:`Proposer` for a single agent.

Production: ``lambda agent: JigProposer(agent)``. Tests pass a
stub-returning factory so the runner can be exercised without LLM
calls.
"""


GraderFactory = Callable[["TargetConfig"], Grader]
"""Build a :class:`Grader` for one target.

The grader runs against the cell's final artifact at end of project.
Different targets want different graders (prose targets a
:class:`BriefJudge`-shaped LLM grader; code targets a HeuristicGrader
with subprocess checks), so the factory closes over per-target
configuration. Pass ``None`` when running cells without eval scoring
(e.g., smoke-tests of the runner itself).
"""


@dataclass(frozen=True, slots=True)
class CellMetrics:
    """Project-level counters captured per cell.

    Per the post-Phase-3 architecture, escalation is automated by
    default and memory commits are operator-driven outside the runner,
    so "operator burden" is more about counting protocol events than
    counting human decisions. These are the events worth tracking for
    cross-condition comparison.
    """

    incremental_commits_attempted: int
    incremental_commits_applied: int
    convergence_rounds_run: int
    convergence_round_converged: int | None  # 1-indexed; None if escalated
    escalation_invoked: bool


@dataclass(frozen=True, slots=True)
class CellResult:
    """Outcome of one (target × condition) cell.

    ``eval_scores`` is populated when ``run_cell`` is given a
    ``grader_factory``; empty list when no grader was supplied (e.g.,
    smoke-tests of the runner itself).
    """

    target_name: str
    condition_name: str
    artifact_path: Path
    final_artifact_content: str
    run_result: ProjectRunResult
    metrics: CellMetrics
    eval_scores: list[Score]


async def run_cell(
    *,
    target: TargetConfig,
    condition: ConditionConfig,
    proposer_factory: ProposerFactory,
    output_dir: Path,
    grader_factory: GraderFactory | None = None,
    tracer: TracingLogger | None = None,
    emit: WorkspaceEventEmitter | None = None,
) -> CellResult:
    """Run a single study cell and return the structured result.

    ``output_dir`` is the study root; the cell's artifact lives at
    ``output_dir/{target.name}/{condition.name}/{artifact_filename}``
    so multiple cells don't stomp on each other. The directory is
    created if missing; the seed content is written before the run.
    """
    cell_dir = output_dir / target.name / condition.name
    cell_dir.mkdir(parents=True, exist_ok=True)
    # The runner only handles file-based artifacts (PROSE markdown or
    # single-file CODE). artifact_filename must be a bare filename
    # with no path separators — anything multi-component would be a
    # directory-style path, and directory-based CODE is deferred to
    # v1.x.
    #
    # Rejects (in order): empty/whitespace-only (would degenerate to
    # the cell directory itself); ``.`` or ``..`` (would point at the
    # cell dir or its parent — silently writing seed_content there
    # would clobber sibling cell state); and multi-component paths
    # via PurePath.parts (catches both POSIX `/` and Windows `\\`).
    stripped = target.artifact_filename.strip()
    if not stripped:
        raise ValueError(
            f"target {target.name!r} artifact_filename is empty or "
            "whitespace-only — must be a real filename"
        )
    if stripped in {".", ".."}:
        raise ValueError(
            f"target {target.name!r} artifact_filename "
            f"{target.artifact_filename!r} resolves to the cell "
            "directory or its parent — must be a real filename"
        )
    if len(PurePath(stripped).parts) != 1:
        raise ValueError(
            f"target {target.name!r} artifact_filename "
            f"{target.artifact_filename!r} contains path separators; "
            "v1 supports single-file artifacts only — directory-based "
            "CODE artifacts are v1.x"
        )
    artifact_path = cell_dir / stripped
    artifact_path.write_text(target.seed_content, encoding="utf-8")

    # Reset agent memory state per run_cell invocation. The harness
    # treats each cell as an independent experiment — cross-run
    # contamination would skew results when the same (target,
    # condition) pair runs more than once in the same output_dir.
    # Studies that *want* to observe cross-run memory effects can
    # opt in by varying output_dir (e.g., per-run timestamp).
    agent_data_root = cell_dir / "agent_memory"
    if agent_data_root.exists():
        shutil.rmtree(agent_data_root)
    agents = _build_agents(
        target=target,
        n=condition.n,
        agent_data_root=agent_data_root,
    )
    # Stable cell-id string used for both Project.id and the
    # Enrollment.project_id pointers so downstream consumers that
    # expect them to match (the design memo's data model invariant)
    # see a consistent reference. Also gives Workstream D a
    # human-readable handle for cross-cell aggregation.
    cell_project_id = f"{target.name}-{condition.name}"
    project = Project(
        id=cell_project_id,
        artifact=Artifact(type=target.artifact_type, path=artifact_path),
        brief=target.brief,
        enrollments=[
            Enrollment(agent_id=a.id, project_id=cell_project_id)
            for a in agents
        ],
        coordination_protocol=condition.coordination_protocol,
    )
    proposers: dict[str, Proposer] = {a.id: proposer_factory(a) for a in agents}
    # Per-commit snapshots colocated with the final artifact so a
    # post-mortem can diff the cell's evolution after the run. Best-
    # effort observation; failure to snapshot doesn't fail the apply.
    mediator = Mediator(
        project.artifact,
        [a.id for a in agents],
        snapshot_dir=cell_dir / "commits",
    )

    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        consensus_mechanism_factory=condition.consensus_mechanism_factory,
        tracer=tracer or StdoutTracer(color=False),
        emit=emit,
    )
    run_result = await coordinator.run()

    final_content = artifact_path.read_text(encoding="utf-8")
    metrics = _summarize_metrics(run_result)
    eval_scores: list[Score] = []
    if grader_factory is not None:
        grader = grader_factory(target)
        eval_scores = list(
            await grader.grade(
                input=target.brief.target_spec, output=final_content
            )
        )
    return CellResult(
        target_name=target.name,
        condition_name=condition.name,
        artifact_path=artifact_path,
        final_artifact_content=final_content,
        run_result=run_result,
        metrics=metrics,
        eval_scores=eval_scores,
    )


async def run_study(
    *,
    targets: Sequence[TargetConfig],
    conditions: Sequence[ConditionConfig],
    proposer_factory: ProposerFactory,
    output_dir: Path,
    grader_factory: GraderFactory | None = None,
    tracer: TracingLogger | None = None,
    emit: WorkspaceEventEmitter | None = None,
) -> list[CellResult]:
    """Run every (target, condition) pair sequentially.

    Returns the cell results in (target outer, condition inner) order
    — same iteration shape as ``itertools.product(targets, conditions)``
    so downstream aggregation can group consistently.

    A cell that raises propagates immediately; surrounding cells
    don't run. Use ``return_exceptions=True`` semantics in a custom
    wrapper if you'd rather collect partial results from a flaky
    target.
    """
    output_dir.mkdir(parents=True, exist_ok=True)
    results: list[CellResult] = []
    for target in targets:
        for condition in conditions:
            logger.info(
                "running cell target=%s condition=%s",
                target.name,
                condition.name,
            )
            result = await run_cell(
                target=target,
                condition=condition,
                proposer_factory=proposer_factory,
                output_dir=output_dir,
                grader_factory=grader_factory,
                tracer=tracer,
                emit=emit,
            )
            results.append(result)
    return results


def _build_agents(
    *,
    target: TargetConfig,
    n: int,
    agent_data_root: Path,
) -> list[Agent]:
    """Build n agents from the target's model + frame pools.

    Agents cycle through both pools — for ``n <= len(model_pool)``
    every agent has a distinct model, satisfying the
    heterogeneity-by-model-identity check at enrollment. Beyond
    that the operator opted out of mechanical heterogeneity by
    sizing n above the pool.
    """
    if n <= 0:
        raise ValueError(f"n must be positive, got {n}")
    if not target.model_pool:
        raise ValueError(
            f"target {target.name!r} has empty model_pool — "
            "can't build any agents"
        )
    agent_data_root.mkdir(parents=True, exist_ok=True)
    agents: list[Agent] = []
    for i in range(n):
        model = target.model_pool[i % len(target.model_pool)]
        frame: str | None = None
        if target.frame_pool:
            frame = target.frame_pool[i % len(target.frame_pool)]
        agents.append(
            Agent(
                name=f"{target.name}-agent-{i}",
                model=model,
                system_prompt=_default_system_prompt(target.name, i),
                frame=frame,
                memory_db_path=agent_data_root / f"agent-{i}.db",
            )
        )
    return agents


def _default_system_prompt(target_name: str, index: int) -> str:
    """Minimal placeholder system prompt.

    Workstream D will supply project-specific prompts; the harness
    just needs *something* non-empty so Agent passes pydantic
    validation. The frame attached separately on the Agent provides
    the per-agent stance differentiation.
    """
    return (
        f"You are agent #{index} working on the {target_name!r} project. "
        "Read the brief and current artifact carefully and propose the "
        "next version. Stay focused on the success criteria."
    )


def _summarize_metrics(run_result: ProjectRunResult) -> CellMetrics:
    incremental: IncrementalRunResult | None = run_result.incremental
    consensus = run_result.consensus

    if incremental is None:
        commits_attempted = 0
        commits_applied = 0
    else:
        commits_attempted = len(incremental.outcomes)
        commits_applied = sum(
            1
            for o in incremental.outcomes
            if o.result == ProposalResult.APPLIED
        )

    if consensus is None:
        rounds_run = 0
        converged_at = None
        escalated = False
    else:
        rounds_run = len(consensus.rounds)
        converged_at = consensus.converged_at_round
        # Read the authoritative signal from the consensus mechanism —
        # not "no round converged". SingleRoundConsensus always runs
        # the escalate step (its DisagreementSurface is authoritative)
        # even when round 1 happens to converge byte-identically.
        escalated = consensus.picked_via_escalation

    return CellMetrics(
        incremental_commits_attempted=commits_attempted,
        incremental_commits_applied=commits_applied,
        convergence_rounds_run=rounds_run,
        convergence_round_converged=converged_at,
        escalation_invoked=escalated,
    )
