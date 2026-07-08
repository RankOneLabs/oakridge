"""Spec-driven entrypoint for legit-biz-club.

Reads a JSON run-spec, validates it, resolves task/condition/grader
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
import re
import sys
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path, PurePath
from typing import cast

from jig.tracing.stdout import StdoutTracer

from legit_biz_club import JigProposer, WorkspaceEventEmitter
from legit_biz_club.core.models import ArtifactType, Brief
from legit_biz_club.study import registry
from legit_biz_club.study.layout import cell_dir_path, is_reserved_sidecar_name
from legit_biz_club.study.runner import GraderFactory, run_cell
from legit_biz_club.study.targets import TaskConfig, code_task, prose_task

_SNAKE_CASE_RE = re.compile(r"^[a-z][a-z0-9_]*$")


@dataclass(frozen=True, slots=True)
class GraderRef:
    kind: str
    key: str | None = None
    name: str | None = None
    config: dict[str, object] | None = None


@dataclass(frozen=True, slots=True)
class ConditionSpec:
    kind: str
    n: int


@dataclass(frozen=True, slots=True)
class RunSpec:
    task: str
    model_pool: tuple[str, ...]
    condition: ConditionSpec
    grade: bool = True
    grader: GraderRef | None = None
    local_task_dir: Path | None = None
    local_grader_config_dir: Path | None = None

    @property
    def target(self) -> str:
        """Legacy target compatibility alias for older callers."""
        return self.task

    @classmethod
    def from_dict(cls, data: dict[str, object]) -> RunSpec:
        task_raw = data.get("task")
        target_raw = data.get("target")  # legacy target compatibility
        if task_raw is None and target_raw is None:
            raise ValueError("task is required")
        if task_raw is not None and target_raw is not None:
            raise ValueError("spec may use either task or target, not both")
        task_value = task_raw if task_raw is not None else target_raw
        if not isinstance(task_value, str):
            raise ValueError(f"task must be a string, got {task_value!r}")

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
                f"condition.kind must be one of "
                f"{list(registry.CONDITION_FACTORIES)!r}, got {kind!r}"
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
        condition = ConditionSpec(kind=kind, n=n_raw)

        grade_raw = data.get("grade", True)
        if not isinstance(grade_raw, bool):
            raise ValueError(f"grade must be a bool, got {grade_raw!r}")

        grader_raw = data.get("grader")
        grader = _parse_grader_ref(grader_raw) if grader_raw is not None else None

        local_task_dir_raw = data.get("local_task_dir")
        local_task_dir = _parse_optional_path(
            local_task_dir_raw, field_name="local_task_dir"
        )

        local_grader_config_dir_raw = data.get("local_grader_config_dir")
        local_grader_config_dir = _parse_optional_path(
            local_grader_config_dir_raw,
            field_name="local_grader_config_dir",
        )

        if (
            task_value not in registry.TARGET_FACTORIES
            and local_task_dir is None
        ):
            raise ValueError(
                f"task must be one of {list(registry.TARGET_FACTORIES)!r}, got {task_value!r}"
            )

        if local_task_dir is not None:
            _validate_local_task_catalog(local_task_dir)

        return cls(
            task=task_value,
            model_pool=model_pool,
            condition=condition,
            grade=grade_raw,
            grader=grader,
            local_task_dir=local_task_dir,
            local_grader_config_dir=local_grader_config_dir,
        )

    def resolve_task(self) -> TaskConfig:
        if self.task in registry.TARGET_FACTORIES:
            return registry.TARGET_FACTORIES[self.task]()
        if self.local_task_dir is None:
            raise ValueError(
                f"task {self.task!r} is not registered and local_task_dir is missing"
            )
        catalog = _load_local_task_catalog(self.local_task_dir)
        try:
            return catalog[self.task]
        except KeyError as exc:
            raise ValueError(
                f"no local task named {self.task!r} in {self.local_task_dir}"
            ) from exc

    def resolve_grader(self, task: TaskConfig) -> GraderFactory | None:
        if not self.grade:
            return None
        if self.grader is None:
            if task.name in registry.TARGET_FACTORIES:
                return registry.grader_factory_for(task.name)
            raise ValueError(
                f"grade=true requires a grader for local task {task.name!r}"
            )
        return _resolve_grader_ref(
            self.grader,
            task=task,
            local_grader_config_dir=self.local_grader_config_dir,
        )


def _parse_optional_path(
    raw: object, *, field_name: str
) -> Path | None:
    if raw is None:
        return None
    if not isinstance(raw, str) or raw.strip() == "":
        raise ValueError(f"{field_name} must be a non-empty string path, got {raw!r}")
    return Path(raw)


def _parse_grader_ref(raw: object) -> GraderRef:
    if not isinstance(raw, dict):
        raise ValueError(f"grader must be an object, got {raw!r}")
    kind = raw.get("kind")
    if not isinstance(kind, str):
        raise ValueError(f"grader.kind must be a string, got {kind!r}")
    if kind == "registered":
        key = raw.get("key")
        if not isinstance(key, str) or key == "":
            raise ValueError(f"grader.key must be a non-empty string, got {key!r}")
        config_raw = raw.get("config")
        if config_raw is None:
            config = None
        elif isinstance(config_raw, dict):
            config = config_raw
        else:
            raise ValueError(f"grader.config must be an object, got {config_raw!r}")
        return GraderRef(kind=kind, key=key, config=config)
    if kind == "local_config":
        name = raw.get("name")
        if not isinstance(name, str) or not _SNAKE_CASE_RE.fullmatch(name):
            raise ValueError(
                f"grader.name must be snake_case starting with a letter, got {name!r}"
            )
        return GraderRef(kind=kind, name=name)
    raise ValueError(
        "grader.kind must be one of ['registered', 'local_config'], "
        f"got {kind!r}"
    )


def _parse_brief(raw: object, *, task_name: str) -> Brief:
    if not isinstance(raw, dict):
        raise ValueError(f"task {task_name!r} brief must be an object")
    target_spec = raw.get("target_spec")
    if not isinstance(target_spec, str) or target_spec.strip() == "":
        raise ValueError("target_spec must be a non-empty string")
    success_criteria_raw = raw.get("success_criteria")
    if not isinstance(success_criteria_raw, list) or len(success_criteria_raw) == 0:
        raise ValueError("success_criteria must be a non-empty list")
    success_criteria: list[str] = []
    for criterion in success_criteria_raw:
        if not isinstance(criterion, str) or criterion.strip() == "":
            raise ValueError(
                "every success_criteria entry must be a non-empty string"
            )
        success_criteria.append(criterion)
    constraints_raw = raw.get("constraints", [])
    if not isinstance(constraints_raw, list):
        raise ValueError("constraints must be a list")
    constraints: list[str] = []
    for constraint in constraints_raw:
        if not isinstance(constraint, str) or constraint.strip() == "":
            raise ValueError("every constraints entry must be a non-empty string")
        constraints.append(constraint)
    return Brief(
        target_spec=target_spec,
        success_criteria=success_criteria,
        constraints=constraints,
    )


def _validate_snake_case_name(name: object, *, field_name: str) -> str:
    if not isinstance(name, str) or not _SNAKE_CASE_RE.fullmatch(name):
        raise ValueError(
            f"{field_name} must be snake_case starting with a letter, got {name!r}"
        )
    return name


def _validate_artifact_filename(
    artifact_filename: object, *, task_name: str, artifact_type: ArtifactType
) -> str:
    if not isinstance(artifact_filename, str):
        raise ValueError(
            f"task {task_name!r} artifact_filename must be a string, got {artifact_filename!r}"
        )
    stripped = artifact_filename.strip()
    if not stripped:
        raise ValueError(
            f"task {task_name!r} artifact_filename must not be empty or whitespace-only"
        )
    if stripped in {".", ".."}:
        raise ValueError(
            f"task {task_name!r} artifact_filename {artifact_filename!r} is invalid"
        )
    if "/" in stripped or "\\" in stripped or len(PurePath(stripped).parts) != 1:
        raise ValueError(
            f"task {task_name!r} artifact_filename {artifact_filename!r} must be a bare filename"
        )
    if is_reserved_sidecar_name(stripped):
        raise ValueError(
            f"task {task_name!r} artifact_filename {artifact_filename!r} "
            "collides with a reserved sidecar name"
        )
    if artifact_type is ArtifactType.CODE and not stripped.endswith(".py"):
        raise ValueError(
            f"task {task_name!r} code artifact_filename must end with .py, "
            f"got {artifact_filename!r}"
        )
    return stripped


def _parse_model_pool(raw: object, *, task_name: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or len(raw) == 0:
        raise ValueError(f"task {task_name!r} model_pool must be a non-empty list")
    model_pool: list[str] = []
    for entry in raw:
        if not isinstance(entry, str) or entry == "":
            raise ValueError(
                f"task {task_name!r} model_pool entries must be non-empty strings"
            )
        model_pool.append(entry)
    return tuple(model_pool)


def _parse_frame_pool(raw: object, *, task_name: str) -> tuple[str | None, ...]:
    if raw is None:
        return tuple()
    if not isinstance(raw, list):
        raise ValueError(f"task {task_name!r} frame_pool must be a list")
    frame_pool: list[str | None] = []
    for entry in raw:
        if entry is not None and (not isinstance(entry, str) or entry == ""):
            raise ValueError(
                f"task {task_name!r} frame_pool entries must be strings or null"
            )
        frame_pool.append(entry)
    return tuple(frame_pool)


def _load_local_task_catalog(local_task_dir: Path) -> dict[str, TaskConfig]:
    if not local_task_dir.exists():
        raise ValueError(f"local_task_dir {local_task_dir} does not exist")
    if not local_task_dir.is_dir():
        raise ValueError(f"local_task_dir {local_task_dir} must be a directory")
    catalog: dict[str, TaskConfig] = {}
    for json_path in sorted(local_task_dir.glob("*.json")):
        task = _load_local_task(json_path)
        if task.name in registry.TARGET_FACTORIES:
            raise ValueError(
                f"local task {task.name!r} collides with built-in task names"
            )
        if task.name in catalog:
            raise ValueError(f"duplicate local task name {task.name!r}")
        catalog[task.name] = task
    return catalog


def _validate_local_task_catalog(local_task_dir: Path) -> None:
    _load_local_task_catalog(local_task_dir)


def _load_local_task(task_path: Path) -> TaskConfig:
    try:
        raw = json.loads(task_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"malformed JSON in local task file {task_path}: {exc}"
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(f"local task file {task_path} must contain a JSON object")
    name = _validate_snake_case_name(raw.get("name"), field_name="task.name")
    artifact_type_raw = raw.get("artifact_type")
    if not isinstance(artifact_type_raw, str):
        raise ValueError(
            f"task {name!r} artifact_type must be a string, got {artifact_type_raw!r}"
        )
    try:
        artifact_type = ArtifactType(artifact_type_raw)
    except ValueError as exc:
        raise ValueError(
            f"task {name!r} artifact_type must be one of "
            f"{[t.value for t in ArtifactType]!r}"
        ) from exc
    artifact_filename = _validate_artifact_filename(
        raw.get("artifact_filename"),
        task_name=name,
        artifact_type=artifact_type,
    )
    brief = _parse_brief(raw.get("brief"), task_name=name)
    model_pool = _parse_model_pool(raw.get("model_pool"), task_name=name)
    seed_content_raw = raw.get("seed_content", "")
    if not isinstance(seed_content_raw, str):
        raise ValueError(f"task {name!r} seed_content must be a string")
    frame_pool = _parse_frame_pool(raw.get("frame_pool"), task_name=name)
    if artifact_type is ArtifactType.PROSE:
        return prose_task(
            name=name,
            artifact_filename=artifact_filename,
            seed_content=seed_content_raw,
            brief=brief,
            model_pool=model_pool,
            frame_pool=frame_pool,
        )
    return code_task(
        name=name,
        artifact_filename=artifact_filename,
        seed_content=seed_content_raw,
        brief=brief,
        model_pool=model_pool,
        frame_pool=frame_pool,
    )


def _resolve_grader_ref(
    grader: GraderRef,
    *,
    task: TaskConfig,
    local_grader_config_dir: Path | None,
) -> GraderFactory:
    if grader.kind == "registered":
        return _resolve_registered_grader(grader.key, task=task)
    if local_grader_config_dir is None:
        raise ValueError(
            f"grader {grader.name!r} requires local_grader_config_dir"
        )
    return _resolve_local_grader_config(
        grader.name,
        task=task,
        local_grader_config_dir=local_grader_config_dir,
    )


def _resolve_registered_grader(key: str | None, *, task: TaskConfig) -> GraderFactory:
    if key is None:
        raise ValueError("registered grader missing key")
    task_summary = registry.TASK_CATALOG_BY_NAME.get(task.name)
    expected_key = task_summary.grader_key if task_summary is not None else None
    if expected_key is not None and key != expected_key:
        raise ValueError(
            f"task {task.name!r} requires registered grader {expected_key!r}, got {key!r}"
        )
    metadata = registry.grader_metadata_for(key)
    if task.artifact_type not in metadata.supported_artifact_types:
        raise ValueError(
            f"grader {key!r} does not support artifact type {task.artifact_type.value!r}"
        )
    return registry.grader_factory_for(key)


def _resolve_local_grader_config(
    name: str | None,
    *,
    task: TaskConfig,
    local_grader_config_dir: Path,
) -> GraderFactory:
    if name is None:
        raise ValueError("local grader config missing name")
    config_path = local_grader_config_dir / f"{name}.json"
    if not config_path.exists():
        raise ValueError(
            f"no local grader config named {name!r} in {local_grader_config_dir}"
        )
    try:
        raw = json.loads(config_path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as exc:
        raise ValueError(
            f"malformed JSON in local grader config {config_path}: {exc}"
        ) from exc
    if not isinstance(raw, dict):
        raise ValueError(f"local grader config {config_path} must contain a JSON object")
    key = raw.get("key")
    if not isinstance(key, str) or key == "":
        raise ValueError(f"local grader config {config_path} must include a non-empty key")
    config_raw = raw.get("config")
    if config_raw is not None and not isinstance(config_raw, dict):
        raise ValueError(f"local grader config {config_path} config must be an object")
    return _resolve_registered_grader(key, task=task)


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
        print(f"[workspace_event] {kind} :: {payload}", file=sys.stderr, flush=True)
        with jsonl_path.open("a", encoding="utf-8") as f:
            f.write(json.dumps(record) + "\n")

    return cast(WorkspaceEventEmitter, _emit)


async def main(spec_path: str, output_dir: str) -> None:
    spec_data: dict[str, object] = json.loads(
        Path(spec_path).read_text(encoding="utf-8")
    )
    spec = RunSpec.from_dict(spec_data)

    target = spec.resolve_task()
    target = dataclasses.replace(target, model_pool=spec.model_pool)
    condition = registry.CONDITION_FACTORIES[spec.condition.kind](n=spec.condition.n)
    grader = spec.resolve_grader(target)

    cell_dir = cell_dir_path(Path(output_dir), target.name, condition.name)
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
    if not spec.grade or result.grading_error is not None:
        eval_scores = None
    else:
        eval_scores = [
            {
                "dimension": s.dimension,
                "value": s.value,
                "source": s.source.value,
            }
            for s in result.eval_scores
        ]

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
