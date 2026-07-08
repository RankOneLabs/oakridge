"""Study runner — drives one cell of the study end-to-end.

Given a :class:`TaskConfig` and a :class:`ConditionConfig`, builds
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

import asyncio
import contextlib
import json
import logging
import os
import shutil
import tempfile
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Protocol

from jig.core.types import Grader, Score, TracingLogger
from jig.tracing.stdout import StdoutTracer

from legit_biz_club.composition import HeterogeneityCheckFailed, check_heterogeneity
from legit_biz_club.coordination.consensus import WorkspaceEventEmitter
from legit_biz_club.coordination.coordinator import IncrementalRunResult
from legit_biz_club.coordination.events import GradingFailedPayload
from legit_biz_club.coordination.mediator import Mediator
from legit_biz_club.coordination.project_coordinator import (
    ProjectCoordinator,
    ProjectRunResult,
)
from legit_biz_club.coordination.proposal import ProposalResult
from legit_biz_club.coordination.proposer import Proposer
from legit_biz_club.core.lifecycle import ProjectState, transition_to
from legit_biz_club.core.models import (
    Agent,
    Artifact,
    Enrollment,
    Project,
)
from legit_biz_club.memory import PeerContextLoader
from legit_biz_club.study.conditions import ConditionConfig
from legit_biz_club.study.targets import TaskConfig

logger = logging.getLogger(__name__)


# Names that v1's harness colocates with the artifact inside the cell
# directory. Reserving these as artifact_filename values keeps a
# foot-shooting target spec from clobbering (or being clobbered by) a
# sidecar — `commits/` would crash rmtree/mkdir, `agent_memory/`
# would mix into per-agent SqliteStore files, `events.jsonl` would
# get appended to by the driver's tee callback. The shared driver
# script (`scripts/run_one_project.py`) writes events.jsonl, so the
# reserved set covers script-level conventions too rather than just
# lib-internal sidecars — operators inheriting that script don't have
# to re-discover the collision.
_RESERVED_CELL_DIR_NAMES: frozenset[str] = frozenset(
    {"commits", "agent_memory", "events.jsonl", "eval_scores.json"}
)
# Casefolded copy for the membership check. The harness runs on
# operator machines that may use case-insensitive filesystems
# (macOS APFS by default, Windows NTFS), where ``Eval_Scores.json``
# and ``eval_scores.json`` resolve to the same on-disk file. The
# reserved-name guard has to reject both shapes or the foot-shoot
# leaks back in on those filesystems.
_RESERVED_CELL_DIR_NAMES_CASEFOLDED: frozenset[str] = frozenset(
    n.casefold() for n in _RESERVED_CELL_DIR_NAMES
)


class ProposerFactory(Protocol):
    """Build a :class:`Proposer` for a single agent.

    Production: ``lambda agent, *, context="": JigProposer(agent, context=context)``.
    Tests use stub-returning factories that ignore ``context``.

    ``context`` is the peer context string the harness loaded for
    this agent (via :data:`PeerContextLoader`); empty when no loader
    is wired or when the loader returned an empty string. The
    factory is responsible for plumbing it into the proposer (most
    just pass it through to the constructor); ignoring it is fine
    when the proposer doesn't care.
    """

    def __call__(
        self, agent: Agent, *, context: str = ""
    ) -> Proposer: ...


GraderFactory = Callable[["TaskConfig"], Grader]
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
    ``grader_factory`` and grading succeeds; empty list when no grader
    was supplied or when grader construction/execution fails.

    ``grading_error`` is non-None when a grader_factory was supplied but
    grader construction or execution raised. It carries a short
    ``<ExceptionClass>: <message>`` string for operator diagnostics.
    The artifact is preserved exactly as produced; only grading was lost.
    """

    target_name: str
    condition_name: str
    artifact_path: Path
    final_artifact_content: str
    run_result: ProjectRunResult
    metrics: CellMetrics
    eval_scores: list[Score]
    grading_error: str | None = None


async def run_cell(
    *,
    target: TaskConfig,
    condition: ConditionConfig,
    proposer_factory: ProposerFactory,
    output_dir: Path,
    grader_factory: GraderFactory | None = None,
    peer_context_loader: PeerContextLoader | None = None,
    tracer: TracingLogger | None = None,
    emit: WorkspaceEventEmitter | None = None,
) -> CellResult:
    """Run a single study cell and return the structured result.

    ``output_dir`` is the study root; the cell's artifact lives at
    ``output_dir/{target.name}/{condition.name}/{artifact_filename}``
    so multiple cells don't stomp on each other. The directory is
    created if missing; the seed content is written before the run.

    ``peer_context_loader`` (when provided) is called once per agent
    after enrollment to assemble the context string the proposer
    factory receives via the ``context`` kwarg. Default ``None``
    passes empty context — agents start the project fresh.
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
    if stripped.casefold() in _RESERVED_CELL_DIR_NAMES_CASEFOLDED:
        raise ValueError(
            f"target {target.name!r} artifact_filename "
            f"{target.artifact_filename!r} collides with a reserved "
            "sidecar name — pick a different filename"
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
    # Create in INITIALIZED with no enrollments, then drive the lifecycle:
    # INITIALIZED → ENROLLING → (heterogeneity gate) → attach enrollments.
    project = Project(
        id=cell_project_id,
        artifact=Artifact(type=target.artifact_type, path=artifact_path),
        brief=target.brief,
        enrollments=[],
        coordination_protocol=condition.coordination_protocol,
    )
    project.state = transition_to(project.state, ProjectState.ENROLLING)
    proposed_enrollments = [
        Enrollment(agent_id=a.id, project_id=cell_project_id) for a in agents
    ]
    violations = check_heterogeneity(agents, proposed_enrollments, condition.composition_policy)
    if violations:
        raise HeterogeneityCheckFailed(violations)
    project.enrollments = proposed_enrollments
    # Load peer context per agent if a loader was provided. The factory
    # always receives a ``context`` kwarg — empty string when no loader
    # is wired (or when a loader returned ""). Calling factories
    # uniformly keeps the protocol predictable.
    #
    # asyncio.gather rather than a sequential await chain so per-agent
    # latency adds up to max() rather than sum() — negligible for the
    # SQLite loader, but PeerContextLoader is the documented seam for
    # future remote backends (honcho deriver queries, LLM-summarized
    # context, etc.) where it scales linearly with n.
    if peer_context_loader is not None:
        loaded = await asyncio.gather(
            *(peer_context_loader(a, project) for a in agents)
        )
        contexts = {a.id: ctx for a, ctx in zip(agents, loaded, strict=True)}
    else:
        contexts = {a.id: "" for a in agents}
    proposers: dict[str, Proposer] = {
        a.id: proposer_factory(a, context=contexts[a.id]) for a in agents
    }
    # Per-commit snapshots colocated with the final artifact so a
    # post-mortem can diff the cell's evolution after the run. Best-
    # effort observation; failure to snapshot doesn't fail the apply.
    # Wipe any prior commits/ first — a shorter rerun would otherwise
    # leave stale higher-numbered files from the previous run because
    # Mediator restarts numbering at v0001 each invocation.
    snapshot_dir = cell_dir / "commits"
    if snapshot_dir.exists():
        shutil.rmtree(snapshot_dir)
    # Clear any stale eval_scores.json from a previous run alongside
    # the other per-run sidecar resets above. The absent-file semantics
    # ("no scores were persisted") have to hold across reruns even when
    # the coordinator crashes mid-run — clearing here rather than after
    # ``coordinator.run()`` ensures a failed rerun can't leak the
    # previous run's scores to the dashboard.
    sidecar_path = cell_dir / "eval_scores.json"
    try:
        sidecar_path.unlink()
    except FileNotFoundError:
        pass
    except OSError as e:
        logger.warning(
            "eval_scores sidecar cleanup failed (path=%s): %s",
            sidecar_path,
            e,
        )
    mediator = Mediator(
        project.artifact,
        [a.id for a in agents],
        snapshot_dir=snapshot_dir,
    )

    termination_policy = (
        condition.termination_policy_factory()
        if condition.termination_policy_factory is not None
        else None
    )
    coordinator = ProjectCoordinator(
        project=project,
        agents=agents,
        proposers=proposers,
        mediator=mediator,
        termination_policy=termination_policy,
        consensus_mechanism_factory=condition.consensus_mechanism_factory,
        tracer=tracer or StdoutTracer(color=False),
        emit=emit,
    )
    run_result = await coordinator.run()

    final_content = artifact_path.read_text(encoding="utf-8")
    metrics = _summarize_metrics(run_result)
    eval_scores: list[Score] = []
    grading_error: str | None = None
    if grader_factory is not None:
        try:
            grader = grader_factory(target)
            eval_scores = list(
                await grader.grade(
                    input=target.brief.target_spec, output=final_content
                )
            )
            _write_eval_scores_sidecar(cell_dir, eval_scores)
        except Exception as exc:
            grading_error = f"{type(exc).__name__}: {exc}"
            logger.warning(
                "grader failed for cell %s/%s — artifact preserved, "
                "eval_scores omitted: %s",
                target.name,
                condition.name,
                grading_error,
            )
            if emit is not None:
                try:
                    await emit(
                        "grading_failed",
                        GradingFailedPayload(
                            target=target.name,
                            condition=condition.name,
                            error_class=type(exc).__name__,
                            error_message=str(exc),
                            artifact_path=str(artifact_path),
                        ),
                    )
                except Exception as emit_exc:
                    logger.warning(
                        "failed to emit grading_failed event: %s", emit_exc
                    )
    return CellResult(
        target_name=target.name,
        condition_name=condition.name,
        artifact_path=artifact_path,
        final_artifact_content=final_content,
        run_result=run_result,
        metrics=metrics,
        eval_scores=eval_scores,
        grading_error=grading_error,
    )


async def run_study(
    *,
    targets: Sequence[TaskConfig],
    conditions: Sequence[ConditionConfig],
    proposer_factory: ProposerFactory,
    output_dir: Path,
    grader_factory: GraderFactory | None = None,
    peer_context_loader: PeerContextLoader | None = None,
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
                peer_context_loader=peer_context_loader,
                tracer=tracer,
                emit=emit,
            )
            results.append(result)
    return results


def _build_agents(
    *,
    target: TaskConfig,
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


def _write_eval_scores_sidecar(
    cell_dir: Path, scores: list[Score]
) -> None:
    """Persist eval scores alongside the cell's other sidecars.

    Writes ``cell_dir/eval_scores.json`` with the shape::

        {"scores": [{"dimension": "...", "value": 0.95, "source": "llm_judge"}, ...]}

    The wrapper envelope (``{"scores": [...]}`` rather than a bare
    list) leaves room for future grader metadata — judge model id,
    grader run timestamp, rubric hash, etc. — without breaking the
    consumer contract.

    Empty scores skips the write entirely. An absent file therefore
    means "no scores were persisted" — either no grader was wired,
    or the grader was wired but produced zero scores. Consumers
    don't need to distinguish those cases (both render as the same
    empty state).

    Atomic write: serialize to a randomly-named dotfile tmp in the
    same directory then ``replace()`` so a concurrent reader (the
    dashboard) can't ever observe a partially-written JSON. The
    Mediator's artifact write uses a deterministic ``<path>.tmp``
    sibling, but that's safe there because the tmp self-targets the
    artifact path; here the tmp lives next to a *foreign*
    user-controlled artifact, so a target named e.g.
    ``eval_scores.json.tmp`` would otherwise be clobbered. Random
    naming via ``tempfile.mkstemp`` rules that collision out
    regardless of artifact filename. Best-effort observability: if
    the write fails (disk full, permissions, etc.) we log a warning
    and continue. ``CellResult.eval_scores`` in the returned object
    is still authoritative; the sidecar is the dashboard's read path.
    """
    if not scores:
        return
    payload = {
        "scores": [
            {
                "dimension": s.dimension,
                "value": s.value,
                "source": s.source.value,
            }
            for s in scores
        ],
    }
    sidecar = cell_dir / "eval_scores.json"
    fd, tmp_str = tempfile.mkstemp(
        dir=cell_dir, prefix=".eval_scores.", suffix=".tmp"
    )
    tmp = Path(tmp_str)
    # ``os.fdopen`` takes ownership of the raw fd from mkstemp and
    # the resulting file object closes it on context exit. The
    # explicit ``os.close`` fallback covers the (vanishingly rare)
    # case where ``fdopen`` itself raises before that ownership
    # transfers — without it the fd would leak, and on Windows an
    # open handle would also block the unlink below.
    fd_owned_by_file = False
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            fd_owned_by_file = True
            f.write(json.dumps(payload, indent=2) + "\n")
        tmp.replace(sidecar)
    except OSError as e:
        logger.warning(
            "eval_scores sidecar write failed (path=%s): %s", sidecar, e
        )
        # Best-effort cleanup of the orphan tmpfile if the write
        # made it that far.
        with contextlib.suppress(OSError):
            tmp.unlink()
    finally:
        if not fd_owned_by_file:
            with contextlib.suppress(OSError):
                os.close(fd)


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
