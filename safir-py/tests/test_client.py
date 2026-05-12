"""Tests for SafirClient using pytest-httpx."""
from __future__ import annotations

import httpx
import pytest
from pytest_httpx import HTTPXMock

from safir_py import SafirClient

BASE = "http://safir.test"


@pytest.fixture
def client() -> SafirClient:
    return SafirClient(base_url=BASE)


@pytest.fixture
def authed_client() -> SafirClient:
    return SafirClient(base_url=BASE, api_token="xyz")


@pytest.mark.asyncio
async def test_get_task(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/42", json={"id": 42, "title": "test"})
    result = await client.get_task(42)
    assert result["id"] == 42
    await client.aclose()


@pytest.mark.asyncio
async def test_create_task(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST", url=f"{BASE}/tasks", json={"id": 1, "title": "new"}
    )
    result = await client.create_task({"title": "new", "project_id": 1})
    assert result["id"] == 1
    await client.aclose()


@pytest.mark.asyncio
async def test_add_dependency(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST", url=f"{BASE}/tasks/1/dependencies", json={}
    )
    await client.add_dependency(task_id=1, depends_on=2)
    request = httpx_mock.get_requests()[0]
    import json
    body = json.loads(request.content)
    assert body == {"depends_on": 2}
    await client.aclose()


@pytest.mark.asyncio
async def test_get_handoffs_for_task(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/tasks/42/handoffs", json=[{"id": "h1", "raw_markdown": "# hi"}]
    )
    result = await client.get_handoffs_for_task(42)
    assert result[0]["id"] == "h1"
    await client.aclose()


@pytest.mark.asyncio
async def test_create_run(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/tasks/42/runs",
        json={"id": "run-1", "status": "running"},
    )
    result = await client.create_run(42, {"executor": "jig", "status": "running"})
    assert result["id"] == "run-1"
    await client.aclose()


@pytest.mark.asyncio
async def test_update_run(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    run_id = "run-abc"
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/runs/{run_id}",
        json={"id": run_id, "status": "completed"},
    )
    result = await client.update_run(run_id, {"status": "completed"})
    assert result["status"] == "completed"
    await client.aclose()


@pytest.mark.asyncio
async def test_create_phase(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    run_id = "run-abc"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/runs/{run_id}/phases",
        json={"id": "ph-1", "target_model": "claude-opus-4-7"},
    )
    result = await client.create_phase(run_id, {"target_model": "claude-opus-4-7"})
    assert result["id"] == "ph-1"
    await client.aclose()


@pytest.mark.asyncio
async def test_update_phase(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    phase_id = "ph-1"
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/phases/{phase_id}",
        json={"id": phase_id, "is_terminal": True},
    )
    result = await client.update_phase(phase_id, {"is_terminal": True})
    assert result["is_terminal"] is True
    await client.aclose()


@pytest.mark.asyncio
async def test_submit_phase_handoff_with_parsed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    phase_id = "ph-2"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/phases/{phase_id}/handoff",
        json={"id": "hoff-1"},
    )
    result = await client.submit_phase_handoff(
        phase_id=phase_id, raw_markdown="X", parsed={"goal": "Y"}
    )
    request = httpx_mock.get_requests()[0]
    import json
    body = json.loads(request.content)
    assert body["raw_markdown"] == "X"
    assert body["parsed"] == {"goal": "Y"}
    assert result["id"] == "hoff-1"
    await client.aclose()


@pytest.mark.asyncio
async def test_submit_phase_handoff_without_parsed(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    phase_id = "ph-3"
    httpx_mock.add_response(
        method="POST",
        url=f"{BASE}/phases/{phase_id}/handoff",
        json={"id": "hoff-2"},
    )
    await client.submit_phase_handoff(phase_id=phase_id, raw_markdown="X")
    request = httpx_mock.get_requests()[0]
    import json
    body = json.loads(request.content)
    assert "parsed" not in body
    await client.aclose()


@pytest.mark.asyncio
async def test_patch_handoff_debrief(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    handoff_id = "hoff-5"
    debrief = {"delivered_summary": "Z", "not_delivered": [], "deviations": []}
    httpx_mock.add_response(
        method="PATCH",
        url=f"{BASE}/handoffs/{handoff_id}/debrief",
        json={"id": handoff_id},
    )
    result = await client.patch_handoff_debrief(handoff_id=handoff_id, debrief=debrief)
    request = httpx_mock.get_requests()[0]
    import json
    body = json.loads(request.content)
    assert body == {"debrief": debrief}
    assert result["id"] == handoff_id
    await client.aclose()


@pytest.mark.asyncio
async def test_get_permission_profile(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(
        url=f"{BASE}/permission-profiles/3",
        json={"id": 3, "rules": {"allow_all": True}},
    )
    result = await client.get_permission_profile(3)
    assert result["id"] == 3
    await client.aclose()


@pytest.mark.asyncio
async def test_auth_header_present(authed_client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/1", json={"id": 1})
    await authed_client.get_task(1)
    request = httpx_mock.get_requests()[0]
    assert request.headers.get("authorization") == "Bearer xyz"
    await authed_client.aclose()


@pytest.mark.asyncio
async def test_no_auth_header_when_no_token(
    client: SafirClient, httpx_mock: HTTPXMock
) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/1", json={"id": 1})
    await client.get_task(1)
    request = httpx_mock.get_requests()[0]
    assert "authorization" not in request.headers
    await client.aclose()


@pytest.mark.asyncio
async def test_raise_for_status_on_404(client: SafirClient, httpx_mock: HTTPXMock) -> None:
    httpx_mock.add_response(url=f"{BASE}/tasks/999", status_code=404)
    with pytest.raises(httpx.HTTPStatusError):
        await client.get_task(999)
    await client.aclose()
