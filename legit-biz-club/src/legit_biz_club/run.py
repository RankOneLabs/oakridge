"""Spec-driven entrypoint for legit-biz-club.

Reads a JSON run-spec, validates it, resolves target/condition/grader
against the study registry, applies the model_pool override, wires the
events.jsonl tee, and drives exactly one cell via run_cell.

Invocation::

    python -m legit_biz_club.run --spec <spec.json> --output-dir <dir>
"""
from __future__ import annotations

import argparse
import asyncio
import dataclasses
import json
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import cast

from jig.tracing.stdout import StdoutTracer

from legit_biz_club import JigProposer, WorkspaceEventEmitter
from legit_biz_club.study import registry
from legit_biz_club.study.runner import run_cell


@dataclass(frozen=True, slots=True)
class ConditionSpec:
    kind: str
    n: int


@dataclass(frozen=True, slots=True)
class RunSpec:
    target: str
    model_pool: tuple[str, ...]
    condition: ConditionSpec
    grade: bool = True

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> RunSpec:
        target = data.get("target")
        if not isinstance(target, str) or target not in registry.TARGET_FACTORIES:
            raise ValueError(
                f"target must be one of {list(registry.TARGET_FACTORIES)!r}, got {target!r}"
            )

        model_pool_raw = data.get("model_pool")
        if not isinstance(model_pool_raw, list) or len(model_pool_raw) == 0:
            raise ValueError("model_pool must be a non-empty list")
        for entry in model_pool_raw:
            if not isinstance(entry, str) or entry == "":
                raise ValueError(
                    f"every model_pool entry must be a non-empty string, got {entry!r}"
                )
        model_pool = tuple(str(e) for e in model_pool_raw)

        condition_raw = data.get("condition")
        if not isinstance(condition_raw, dict):
            raise ValueError("condition must be an object")
        kind = condition_raw.get("kind")
        if not isinstance(kind, str) or kind not in registry.CONDITION_FACTORIES:
            raise ValueError(
                f"condition.kind must be one of {list(registry.CONDITION_FACTORIES)!r}, got {kind!r}"
            )
        n_raw = condition_raw.get("n")
        if not isinstance(n_raw, int) or isinstance(n_raw, bool):
            raise ValueError(f"condition.n must be an int, got {n_raw!r}")
        if n_raw < 1 or n_raw > 16:
            raise ValueError(f"condition.n must be in 1..16, got {n_raw}")
        if kind == "single_agent" and n_raw != 1:
            raise ValueError(f"single_agent requires n == 1, got {n_raw}")
        if kind in ("ensemble_single_round", "ensemble_multi_round") and n_raw < 2:
            raise ValueError(f"{kind} requires n >= 2, got {n_raw}")
        if kind == "ensemble_incremental" and n_raw < 1:
            raise ValueError(f"ensemble_incremental requires n >= 1, got {n_raw}")
        condition = ConditionSpec(kind=kind, n=n_raw)

        grade_raw = data.get("grade", True)
        if not isinstance(grade_raw, bool):
            raise ValueError(f"grade must be a bool, got {grade_raw!r}")

        return cls(
            target=target,
            model_pool=model_pool,
            condition=condition,
            grade=grade_raw,
        )


def _build_event_tee(jsonl_path: Path) -> WorkspaceEventEmitter:
    """Build an emit callback that prints AND appends to a JSONL log.

    Each line: ``{"ts": iso8601, "kind": str, "payload": dict}``.
    """
    jsonl_path.parent.mkdir(parents=True, exist_ok=True)

    async def _emit(kind: str, payload: dict[str, object]) -> None:
        record: dict[str, object] = {
            "ts": datetime.now(UTC).isoformat(),
            "kind": kind,
            "payload": payload,
        }
        print(f"[workspace_event] {kind} :: {payload}", flush=True)
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    return cast(WorkspaceEventEmitter, _emit)


async def main(spec_path: str, output_dir: str) -> None:
    spec_data: dict[str, object] = json.loads(
        Path(spec_path).read_text(encoding="utf-8")
    )
    spec = RunSpec.from_dict(spec_data)

    target = registry.TARGET_FACTORIES[spec.target]()
    target = dataclasses.replace(target, model_pool=spec.model_pool)
    condition = registry.CONDITION_FACTORIES[spec.condition.kind](n=spec.condition.n)
    grader = registry.grader_factory_for(spec.target) if spec.grade else None

    cell_dir = Path(output_dir) / target.name / condition.name
    tee = _build_event_tee(cell_dir / "events.jsonl")

    result = await run_cell(
        target=target,
        condition=condition,
        proposer_factory=lambda agent, *, context="": JigProposer(agent, context=context),
        output_dir=Path(output_dir),
        grader_factory=grader,
        emit=tee,
        tracer=StdoutTracer(color=False),
    )

    eval_scores: list[dict[str, object]] | None
    if spec.grade:
        eval_scores = [
            {
                "dimension": s.dimension,
                "value": s.value,
                "source": s.source.value,
            }
            for s in result.eval_scores
        ]
    else:
        eval_scores = None

    print(
        "RESULT "
        + json.dumps(
            {
                "artifact_path": str(result.artifact_path),
                "eval_scores": eval_scores,
            }
        ),
        flush=True,
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Spec-driven legit-biz-club run entrypoint."
    )
    parser.add_argument("--spec", required=True, help="Path to run-spec JSON file")
    parser.add_argument(
        "--output-dir",
        required=True,
        dest="output_dir",
        help="Output directory",
    )
    args = parser.parse_args()
    asyncio.run(main(args.spec, args.output_dir))
