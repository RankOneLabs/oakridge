"""Minimal httpx-based safir client for planner1."""
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

    async def get_task(self, task_id: int) -> dict[str, Any]:
        r = await self._client.get(f"{self._base_url}/tasks/{task_id}", headers=self._headers())
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


def safir_base_url_from_env() -> str:
    return os.environ.get("SAFIR_BASE_URL", "http://localhost:7145")


def safir_api_token_from_env() -> str | None:
    return os.environ.get("SAFIR_API_TOKEN") or None
