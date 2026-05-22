"""HTTP client for safir's task / run / phase / handoff API."""
from __future__ import annotations

import os
from typing import Any, NotRequired, TypedDict

import httpx

from .models import (
    AgentResponseAck,
    AtomEdit,
    AtomMap,
    BuildBrief,
    Handoff,
    PermissionProfile,
    Phase,
    Plan,
    Run,
    Task,
    Thread,
    ThreadMessage,
)


class SafirAtomEditConflict(Exception):
    """Raised by post_atom_edit when safir returns 409 stale_prev_value."""

    def __init__(
        self,
        *,
        current_value: str | None,
        latest_edit_id: str | None,
        edited_by: str | None,
        created_at: str | None,
    ) -> None:
        super().__init__(
            f"stale_prev_value: current={current_value!r}, latest_edit_id={latest_edit_id}"
        )
        self.current_value = current_value
        self.latest_edit_id = latest_edit_id
        self.edited_by = edited_by
        self.created_at = created_at


class _SubmitPlanCohort(TypedDict):
    cohort_index: int
    title: str
    notes: str
    priority: NotRequired[int]


class _SubmitPlanDependency(TypedDict):
    cohort_index: int
    depends_on_cohort_index: int


class SubmitPlanBody(TypedDict):
    """Request body for `POST /tasks/:id/plans`.

    Mirrors safir's `CreatePlanBody` zod schema. Kept as a TypedDict (not
    a BaseModel) so callers can construct the payload as a plain dict
    without an extra model layer.
    """

    summary: NotRequired[str]
    model: NotRequired[str]
    cohorts: list[_SubmitPlanCohort]
    dependencies: NotRequired[list[_SubmitPlanDependency]]


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

    async def get_task(self, task_id: int) -> Task:
        r = await self._client.get(
            f"{self._base_url}/tasks/{task_id}", headers=self._headers()
        )
        r.raise_for_status()
        return Task.model_validate(r.json())

    async def create_task(self, body: dict[str, Any]) -> Task:
        r = await self._client.post(
            f"{self._base_url}/tasks", json=body, headers=self._headers()
        )
        r.raise_for_status()
        return Task.model_validate(r.json())

    async def add_dependency(self, *, task_id: int, depends_on: int) -> None:
        r = await self._client.post(
            f"{self._base_url}/tasks/{task_id}/dependencies",
            json={"depends_on": depends_on},
            headers=self._headers(),
        )
        r.raise_for_status()

    async def submit_plan(self, parent_task_id: int, body: SubmitPlanBody) -> Plan:
        r = await self._client.post(
            f"{self._base_url}/tasks/{parent_task_id}/plans",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return Plan.model_validate(r.json())

    # --- builder additions ---

    async def get_handoffs_for_task(self, task_id: int) -> list[Handoff]:
        r = await self._client.get(
            f"{self._base_url}/tasks/{task_id}/handoffs", headers=self._headers()
        )
        r.raise_for_status()
        return [Handoff.model_validate(x) for x in r.json()]

    async def create_run(self, task_id: int, body: dict[str, Any]) -> Run:
        r = await self._client.post(
            f"{self._base_url}/tasks/{task_id}/runs",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return Run.model_validate(r.json())

    async def update_run(self, run_id: str, body: dict[str, Any]) -> Run:
        r = await self._client.patch(
            f"{self._base_url}/runs/{run_id}", json=body, headers=self._headers()
        )
        r.raise_for_status()
        return Run.model_validate(r.json())

    async def create_phase(self, run_id: str, body: dict[str, Any]) -> Phase:
        r = await self._client.post(
            f"{self._base_url}/runs/{run_id}/phases",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return Phase.model_validate(r.json())

    async def update_phase(self, phase_id: str, body: dict[str, Any]) -> Phase:
        r = await self._client.patch(
            f"{self._base_url}/phases/{phase_id}",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return Phase.model_validate(r.json())

    async def submit_phase_handoff(
        self,
        *,
        phase_id: str,
        raw_markdown: str,
        parsed: dict[str, Any] | None = None,
    ) -> Handoff:
        body: dict[str, Any] = {"raw_markdown": raw_markdown}
        if parsed is not None:
            body["parsed"] = parsed
        r = await self._client.post(
            f"{self._base_url}/phases/{phase_id}/handoff",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return Handoff.model_validate(r.json())

    async def patch_handoff_debrief(
        self, *, handoff_id: str, debrief: dict[str, Any]
    ) -> Handoff:
        r = await self._client.patch(
            f"{self._base_url}/handoffs/{handoff_id}/debrief",
            json={"debrief": debrief},
            headers=self._headers(),
        )
        r.raise_for_status()
        return Handoff.model_validate(r.json())

    async def get_permission_profile(self, profile_id: int) -> PermissionProfile:
        r = await self._client.get(
            f"{self._base_url}/permission-profiles/{profile_id}",
            headers=self._headers(),
        )
        r.raise_for_status()
        return PermissionProfile.model_validate(r.json())

    # --- review responder surface ---

    async def get_plan(self, plan_id: str) -> Plan:
        r = await self._client.get(
            f"{self._base_url}/plans/{plan_id}", headers=self._headers()
        )
        r.raise_for_status()
        return Plan.model_validate(r.json())

    async def get_build_brief(self, brief_id: str) -> BuildBrief:
        r = await self._client.get(
            f"{self._base_url}/build-briefs/{brief_id}", headers=self._headers()
        )
        r.raise_for_status()
        return BuildBrief.model_validate(r.json())

    async def get_run_by_brief(self, brief_id: str) -> Run:
        r = await self._client.get(
            f"{self._base_url}/build-briefs/{brief_id}/run", headers=self._headers()
        )
        r.raise_for_status()
        return Run.model_validate(r.json())

    async def get_atom_map(self, target_type: str, target_id: str) -> AtomMap:
        r = await self._client.get(
            f"{self._base_url}/atoms/{target_type}/{target_id}",
            headers=self._headers(),
        )
        r.raise_for_status()
        payload: AtomMap = r.json()
        return payload

    async def get_thread(self, thread_id: str) -> Thread:
        r = await self._client.get(
            f"{self._base_url}/threads/{thread_id}", headers=self._headers()
        )
        r.raise_for_status()
        return Thread.model_validate(r.json())

    async def list_open_threads(
        self, target_type: str, target_id: str
    ) -> list[Thread]:
        r = await self._client.get(
            f"{self._base_url}/artifacts/{target_type}/{target_id}/threads",
            params={"status": "open"},
            headers=self._headers(),
        )
        r.raise_for_status()
        return [Thread.model_validate(x) for x in r.json()]

    async def post_atom_edit(
        self, target_type: str, target_id: str, body: dict[str, Any]
    ) -> AtomEdit:
        r = await self._client.post(
            f"{self._base_url}/atoms/{target_type}/{target_id}/edits",
            json=body,
            headers=self._headers(),
        )
        if r.status_code == 409:
            try:
                payload: dict[str, Any] = r.json()
            except Exception:
                payload = {}
            if payload.get("error") == "stale_prev_value":
                raise SafirAtomEditConflict(
                    current_value=payload.get("current_value"),
                    latest_edit_id=payload.get("latest_edit_id"),
                    edited_by=payload.get("edited_by"),
                    created_at=payload.get("created_at"),
                )
        r.raise_for_status()
        return AtomEdit.model_validate(r.json())

    async def post_thread_message(
        self, thread_id: str, body: dict[str, Any]
    ) -> ThreadMessage:
        r = await self._client.post(
            f"{self._base_url}/threads/{thread_id}/messages",
            json=body,
            headers=self._headers(),
        )
        r.raise_for_status()
        return ThreadMessage.model_validate(r.json())

    async def post_agent_response(
        self,
        thread_id: str,
        status: str,
        reply_message_id: str | None = None,
        error: str | None = None,
    ) -> AgentResponseAck:
        payload: dict[str, Any] = {"status": status}
        if reply_message_id is not None:
            payload["reply_message_id"] = reply_message_id
        if error is not None:
            payload["error"] = error
        r = await self._client.post(
            f"{self._base_url}/threads/{thread_id}/agent-response",
            json=payload,
            headers=self._headers(),
        )
        r.raise_for_status()
        return AgentResponseAck.model_validate(r.json())


def safir_base_url_from_env() -> str:
    return os.environ.get("SAFIR_BASE_URL", "http://localhost:7145")


def safir_api_token_from_env() -> str | None:
    return os.environ.get("SAFIR_API_TOKEN") or None
