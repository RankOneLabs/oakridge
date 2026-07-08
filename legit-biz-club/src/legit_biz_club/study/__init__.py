"""v1 study harness.

Builds the configurations for the four-condition × two-domain v1 test
described in the design memo, runs them, and aggregates results.
This is the test infrastructure — actually running the study is
Workstream D, a separate research artifact.

The four conditions per the design memo:

1. Single-agent baseline.
2. Ensemble incremental commits, no convergence.
3. Ensemble incremental + single-round convergence at end.
4. Ensemble incremental + multi-round consensus protocol.

Two domains: prose (technical blog post) and code (small but
non-trivial feature in jig or another existing repo).

Modules:

- :mod:`legit_biz_club.study.conditions` — factory functions for the
  four study conditions.
- :mod:`legit_biz_club.study.targets` — factory functions for the
  prose and code target templates.
- :mod:`legit_biz_club.study.runner` — drives a study: builds the
  project per (target × condition), runs the ProjectCoordinator,
  captures the result.
- :mod:`legit_biz_club.study.results` — aggregation across cells
  (artifacts, traces, eval scores, operator-burden telemetry).
"""

from legit_biz_club.memory import PeerContextLoader
from legit_biz_club.study.conditions import (
    ConditionConfig,
    ensemble_incremental_only,
    ensemble_with_multi_round,
    ensemble_with_single_round,
    single_agent_baseline,
)
from legit_biz_club.study.layout import (
    RESERVED_SIDECAR_NAMES,
    cell_dir_name,
    cell_dir_path,
    is_reserved_sidecar_name,
)
from legit_biz_club.study.registry import (
    GRADER_CATALOG,
    TARGET_FACTORIES,
    TASK_CATALOG,
    TASK_FACTORIES,
    GraderMetadata,
    TaskSummary,
    grader_factory_for,
    grader_metadata_for,
    task_summary_for,
)
from legit_biz_club.study.results import (
    ConditionSummary,
    StudyResult,
    aggregate,
)
from legit_biz_club.study.runner import (
    CellMetrics,
    CellResult,
    GraderFactory,
    ProposerFactory,
    run_cell,
    run_study,
)
from legit_biz_club.study.targets import (
    TaskConfig,
    code_task,
    prose_task,
)
from legit_biz_club.study.v1_graders import (
    make_leetcode_longest_substring_grader_factory,
    make_leetcode_median_two_sorted_arrays_grader_factory,
    make_leetcode_regex_matching_grader_factory,
    make_leetcode_trapping_rain_water_grader_factory,
    make_prose_substrate_thesis_grader_factory,
)
from legit_biz_club.study.v1_targets import (
    code_leetcode_longest_substring,
    code_leetcode_median_two_sorted_arrays,
    code_leetcode_regex_matching,
    code_leetcode_trapping_rain_water,
    prose_substrate_thesis,
)

__all__ = [
    "RESERVED_SIDECAR_NAMES",
    "CellMetrics",
    "CellResult",
    "ConditionConfig",
    "ConditionSummary",
    "GraderFactory",
    "PeerContextLoader",
    "ProposerFactory",
    "StudyResult",
    "TaskConfig",
    "TaskSummary",
    "GraderMetadata",
    "aggregate",
    "cell_dir_name",
    "cell_dir_path",
    "is_reserved_sidecar_name",
    "GRADER_CATALOG",
    "TASK_CATALOG",
    "TASK_FACTORIES",
    "TARGET_FACTORIES",
    "code_leetcode_longest_substring",
    "code_leetcode_median_two_sorted_arrays",
    "code_leetcode_regex_matching",
    "code_leetcode_trapping_rain_water",
    "code_task",
    "make_leetcode_longest_substring_grader_factory",
    "make_leetcode_median_two_sorted_arrays_grader_factory",
    "make_leetcode_regex_matching_grader_factory",
    "make_leetcode_trapping_rain_water_grader_factory",
    "make_prose_substrate_thesis_grader_factory",
    "grader_factory_for",
    "grader_metadata_for",
    "ensemble_incremental_only",
    "ensemble_with_multi_round",
    "ensemble_with_single_round",
    "prose_substrate_thesis",
    "prose_task",
    "task_summary_for",
    "run_cell",
    "run_study",
    "single_agent_baseline",
]
