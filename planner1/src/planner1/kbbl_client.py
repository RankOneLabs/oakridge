"""Minimal httpx-based kbbl client for planner1."""
from __future__ import annotations

import os
from typing import Any

import httpx


class KbblClient:
    def __init__(self, *, base_url: str, timeout: float = 30.0) -> None:
        self._base_url = base_url.rstrip("/")
        self._client = httpx.AsyncClient(timeout=timeout)

    async def aclose(self) -> None:
        await self._client.aclose()

    async def submit_proposal(self, payload: dict[str, Any]) -> dict[str, Any]:
        r = await self._client.post(
            f"{self._base_url}/planning-proposals",
            json=payload,
            headers={"content-type": "application/json"},
        )
        r.raise_for_status()
        return r.json()  # type: ignore[no-any-return]


def kbbl_base_url_from_env() -> str:
    return os.environ.get("KBBL_BASE_URL", "http://localhost:8788")
