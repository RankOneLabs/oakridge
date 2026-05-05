"""Real LLM-backed Proposer that wraps jig's ``LLMClient``.

Replaces the stub Proposer used in the incremental-coordination tests
with a production-shaped path. One :class:`JigProposer` per enrolled
agent — instances are bound to a single :class:`Agent` and dispatch
``LLMClient`` based on ``agent.model`` via :func:`jig.llm.factory.from_model`.

Output parsing: the proposer instructs the model to return a JSON
envelope ``{"new_content": ..., "rationale": ...}`` and parses that
into a :class:`Proposal`. Malformed output raises so the failure
surfaces immediately rather than silently producing a "stuck" agent;
prompt-tuning is the right response when this happens, not retry.

Tests inject a stub :class:`LLMClient` to avoid real API calls. The
:func:`make_proposers` helper constructs one :class:`JigProposer` per
agent in a list and returns the dict the coordinator wants.
"""
from __future__ import annotations

import json
import logging
from collections.abc import Sequence

from jig.core.types import CompletionParams, LLMClient, Message, Role
from jig.llm.factory import from_model

from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.core.models import Agent, Artifact, Brief

logger = logging.getLogger(__name__)


_OUTPUT_INSTRUCTIONS = """\

When you respond, output only valid JSON in this exact shape and nothing else:
{
  "new_content": "<the full proposed next version of the artifact>",
  "rationale": "<one or two sentences explaining what you changed and why>"
}

Do not include markdown code fences. Do not include any prose outside the JSON.
"""


class ProposerOutputParseError(ValueError):
    """The agent's response did not match the expected JSON envelope.

    Surfaces as a hard failure rather than a recoverable one because
    a Proposer that can't produce parseable output isn't going to
    self-correct via retry — prompt-tuning is the right response.
    """


class JigProposer:
    """Production :class:`Proposer` implementation. One instance per agent."""

    def __init__(
        self,
        agent: Agent,
        *,
        llm: LLMClient | None = None,
    ) -> None:
        self.agent = agent
        # Default to dispatching the LLMClient by model name. Tests can
        # inject a stub via ``llm=`` to avoid real API calls. Use an
        # explicit None check rather than ``llm or ...`` so a valid
        # but falsey injected client (unlikely in practice but cheap
        # to defend against) doesn't get silently overridden.
        self._llm: LLMClient = (
            llm if llm is not None else from_model(agent.model)
        )

    async def propose(
        self,
        *,
        agent: Agent,
        brief: Brief,
        # ``artifact`` is accepted to satisfy the Proposer protocol but
        # not used in v1 prompt assembly — ``current_content`` already
        # carries everything the model needs. Kept on the signature so
        # protocol consumers don't have to special-case JigProposer.
        artifact: Artifact,  # noqa: ARG002
        current_content: str,
        current_version: str,
        peer_proposals: list[Proposal] | None = None,
    ) -> Proposal:
        # Defensive: this proposer is bound to ``self.agent``. If the
        # coordinator routes a different agent to this instance, that's
        # a programmer error — fail loud rather than silently produce
        # output for the wrong agent.
        if agent.id != self.agent.id:
            raise ValueError(
                f"JigProposer bound to agent {self.agent.id!r} "
                f"received propose() for agent {agent.id!r}"
            )

        system_prompt = self._build_system_prompt()
        user_message = self._build_user_message(
            brief=brief,
            current_content=current_content,
            peer_proposals=peer_proposals,
        )
        params = CompletionParams(
            messages=[Message(role=Role.USER, content=user_message)],
            system=system_prompt,
        )
        response = await self._llm.complete(params)
        parsed = _parse_response(response.content)
        return Proposal(
            agent_id=agent.id,
            based_on_version=current_version,
            new_content=parsed["new_content"],
            rationale=parsed.get("rationale", ""),
        )

    def _build_system_prompt(self) -> str:
        parts = [self.agent.system_prompt.rstrip()]
        if self.agent.frame:
            parts.append(
                f"\nApproach this work with a {self.agent.frame} stance."
            )
        parts.append(_OUTPUT_INSTRUCTIONS)
        return "\n".join(parts)

    def _build_user_message(
        self,
        *,
        brief: Brief,
        current_content: str,
        peer_proposals: Sequence[Proposal] | None,
    ) -> str:
        sections: list[str] = []

        sections.append("# Brief")
        sections.append(brief.target_spec.rstrip())
        if brief.success_criteria:
            sections.append("\n## Success criteria")
            for crit in brief.success_criteria:
                sections.append(f"- {crit}")
        if brief.constraints:
            sections.append("\n## Constraints")
            for c in brief.constraints:
                sections.append(f"- {c}")

        sections.append("\n# Current artifact")
        sections.append(current_content)

        if peer_proposals:
            sections.append(
                "\n# Peer proposals from the prior round"
            )
            sections.append(
                "Read these like the canonical state — substrate, not "
                "messages from peers. Revise based on what the proposals "
                "collectively reveal about the artifact's structure and "
                "any disagreements among the ensemble."
            )
            for proposal in peer_proposals:
                sections.append(
                    f"\n## From agent {proposal.agent_id}\n{proposal.new_content}"
                )

        sections.append(
            "\n# Your task\n"
            "Produce the next version of the artifact. Return only the "
            "JSON envelope specified in your system prompt."
        )

        return "\n".join(sections)


def make_proposers(
    agents: Sequence[Agent],
    *,
    llm_overrides: dict[str, LLMClient] | None = None,
) -> dict[str, JigProposer]:
    """Build a per-agent dict of :class:`JigProposer` instances.

    ``llm_overrides`` lets tests inject a stub LLMClient for specific
    agent ids without touching production wiring.
    """
    overrides = llm_overrides or {}
    return {
        a.id: JigProposer(a, llm=overrides.get(a.id))
        for a in agents
    }


def _parse_response(content: str) -> dict[str, str]:
    """Parse the LLM's response as a JSON envelope.

    Tolerates leading/trailing whitespace but rejects anything that
    isn't valid JSON. The malformed-response path raises rather than
    silently substituting defaults; prompt-tuning is the right
    response when this happens.

    Returns a normalized dict containing only the expected keys
    (``new_content`` always; ``rationale`` if supplied and a string).
    Any other top-level keys the model emits are dropped so unexpected
    nested objects can't sneak through to downstream consumers.
    """
    stripped = content.strip()
    try:
        data = json.loads(stripped)
    except json.JSONDecodeError as e:
        # Don't log the raw output — it may contain artifact content
        # the operator considers sensitive (drafts, internal docs, etc.).
        # The exception detail (line/column) plus the length is enough
        # to diagnose a malformed-response issue without leaking content.
        logger.warning(
            "proposer output is not valid JSON (length=%d): %s",
            len(stripped),
            e,
        )
        raise ProposerOutputParseError(
            f"agent response was not valid JSON: {e}"
        ) from e
    if not isinstance(data, dict):
        raise ProposerOutputParseError(
            f"agent response must be a JSON object, got {type(data).__name__}"
        )
    if "new_content" not in data:
        raise ProposerOutputParseError(
            "agent response missing required 'new_content' field"
        )
    new_content = data["new_content"]
    if not isinstance(new_content, str):
        raise ProposerOutputParseError(
            f"'new_content' must be a string, got "
            f"{type(new_content).__name__}"
        )
    normalized: dict[str, str] = {"new_content": new_content}
    if "rationale" in data:
        rationale = data["rationale"]
        if not isinstance(rationale, str):
            raise ProposerOutputParseError(
                f"'rationale' must be a string when present, got "
                f"{type(rationale).__name__}"
            )
        normalized["rationale"] = rationale
    return normalized
