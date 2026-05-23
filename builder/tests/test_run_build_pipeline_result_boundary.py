from __future__ import annotations

from pathlib import Path
from unittest.mock import AsyncMock, MagicMock

import pytest

from builder.errors import SafirIOError
from builder.pipeline import run_build_pipeline
from builder.result import Err


@pytest.mark.asyncio
async def test_full_pipeline_returns_err_when_initial_safir_call_fails(
    tmp_path: Path,
) -> None:
    client = MagicMock()
    client.get_task = AsyncMock(side_effect=RuntimeError("safir down"))

    result = await run_build_pipeline(
        child_task_id=42,
        models=("planner-model", "build-model"),
        workdir=tmp_path,
        safir_client=client,
    )

    match result:
        case Err(SafirIOError() as err):
            assert err.op == "run_build_pipeline"
            assert err.entity_id == 42
            assert "safir down" in err.detail
        case _:
            raise AssertionError(f"expected Err(SafirIOError), got {result!r}")
