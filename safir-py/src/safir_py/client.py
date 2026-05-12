"""HTTP client for safir's task / run / phase / handoff API."""
from __future__ import annotations

import os
from typing import Any

import httpx


class SafirClient:
    def __init__(
        self,
        *,
        base_url: str,
        api_token: str | None = None,
        timeout: float = 30.0,
    ) -> None:
        self._base_url = base_url.rstrip("/")
        self._api_token = api_token
        self._client = httpx.AsyncClient(timeout=timeout)

    def _headers(self) -> dict[str, str]:
        h = {"content-type": "application/json"}
        if self._api_token:
            h["authorization"] = f"Bearer {self._api_token}"
        return h

    async def aclose(self) -> None:
        await self._client.aclose()

    # --- planner1 surface (preserved verbatim) ---

    async def get_task(self, task_id: int) -> dict[str, Any]:
        r = await self._client.get(
            f"{self._base_url}/tasks/{task_id}", headers=self._headers()
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def create_task(self, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            f"{self._base_url}/tasks", json=body, headers=self._headers()
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def add_dependency(self, *, task_id: int, depends_on: int) -> None:
        r = await self._client.post(
            f"{self._base_url}/tasks/{task_id}/dependencies",
            json={"depends_on": depends_on},
            headers=self._headers(),
        )
        r.raise_for_status()

    # --- builder additions ---

    async def get_handoffs_for_task(self, task_id: int) -> list[dict[str, Any]]:
        r = await self._client.get(
            f"{self._base_url}/tasks/{task_id}/handoffs", headers=self._headers()
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def create_run(self, task_id: int, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            f"{self._base_url}/tasks/{task_id}/runs",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def update_run(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.patch(
            f"{self._base_url}/runs/{run_id}", json=body, headers=self._headers()
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def create_phase(self, run_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            f"{self._base_url}/runs/{run_id}/phases",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def update_phase(self, phase_id: str, body: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.patch(
            f"{self._base_url}/phases/{phase_id}",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def submit_phase_handoff(
        self,
        *,
        phase_id: str,
        raw_markdown: str,
        parsed: dict[str, Any] | None = None,
    ) -> dict[str, Any]:
        body: dict[str, Any] = {"raw_markdown": raw_markdown}
        if parsed is not None:
            body["parsed"] = parsed
        r = await self._client.post(
            f"{self._base_url}/phases/{phase_id}/handoff",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def patch_handoff_debrief(
        self, *, handoff_id: str, debrief: dict[str, Any]
    ) -> dict[str, Any]:
        r = await self._client.patch(
            f"{self._base_url}/handoffs/{handoff_id}/debrief",
            json={"debrief": debrief},
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def get_permission_profile(self, profile_id: int) -> dict[str, Any]:
        r = await self._client.get(
            f"{self._base_url}/permission-profiles/{profile_id}",
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]


def safir_base_url_from_env() -> str:
    return os.environ.get("SAFIR_BASE_URL", "http://localhost:7145")


def safir_api_token_from_env() -> str | None:
    return os.environ.get("SAFIR_API_TOKEN") or None
