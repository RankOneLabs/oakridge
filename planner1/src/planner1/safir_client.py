"""Minimal httpx-based safir client for planner1."""
from __future__ import annotations

from typing import Any

import httpx


class SafirClient:
    def __init__(self, *, base_url: str, api_token: str | None = None, timeout: float = 30.0) -> None:
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

    async def get_task(self, task_id: int) -> dict[str, Any]:
        r = await self._client.get(
            f"{self._base_url}/tasks/{task_id}", headers=self._headers()
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]

    async def submit_plan(self, parent_task_id: int, payload: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            f"{self._base_url}/tasks/{parent_task_id}/plans",
            json=payload,
            headers=self._headers(),
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]
