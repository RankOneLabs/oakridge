"""Tests for the real jig-backed Proposer.

Uses a stub :class:`LLMClient` (injected via the ``llm`` kwarg) so
tests don't make real API calls. Covers:

- Happy path: stub returns valid JSON envelope, propose() yields the
  expected :class:`Proposal`.
- Bound-agent invariant: passing a different agent to a
  :class:`JigProposer` raises.
- Parse failure paths: non-JSON, JSON-but-not-an-object, missing
  ``new_content``.
- System-prompt assembly: frame appended when present.
- User-message assembly: peer proposals included when supplied.
"""
from __future__ import annotations

from pathlib import Path

import pytest
from jig.core.types import (
    CompletionParams,
    LLMClient,
    LLMResponse,
    Usage,
)

from legit_biz_club import Artifact, ArtifactType, Brief
from legit_biz_club.coordination.jig_proposer import (
    JigProposer,
    ProposerOutputParseError,
    make_proposers,
)
from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.core.models import Agent


class _StubLLM(LLMClient):
    """Records the params it received and returns a canned response."""

    def __init__(self, response_content: str) -> None:
        self._content = response_content
        self.last_params: CompletionParams | None = None

    async def complete(self, params: CompletionParams) -> LLMResponse:
        self.last_params = params
        return LLMResponse(
            content=self._content,
            tool_calls=None,
            usage=Usage(input_tokens=10, output_tokens=20),
            latency_ms=42.0,
            model="stub",
        )


def _agent(tmp_path: Path, *, frame: str | None = None) -> Agent:
    return Agent(
        name="alice",
        model="claude-sonnet-4-5",
        system_prompt="You are a careful editor.",
        frame=frame,
        memory_db_path=tmp_path / "alice.db",
    )


def _brief() -> Brief:
    return Brief(
        target_spec="Draft a one-paragraph summary of the project.",
        success_criteria=["under 100 words", "uses plain language"],
        constraints=["no marketing language"],
    )


def _artifact(tmp_path: Path) -> Artifact:
    p = tmp_path / "draft.md"
    p.write_text("seed content", encoding="utf-8")
    return Artifact(type=ArtifactType.PROSE, path=p)


# --- happy path ----------------------------------------------------------


async def test_propose_returns_proposal_from_json(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            '{"new_content": "the revised paragraph", '
            '"rationale": "tightened wording"}'
        )
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed content",
        current_version="v0",
    )
    assert isinstance(proposal, Proposal)
    assert proposal.agent_id == agent.id
    assert proposal.based_on_version == "v0"
    assert proposal.new_content == "the revised paragraph"
    assert proposal.rationale == "tightened wording"


async def test_propose_passes_max_tokens_through_to_llm(tmp_path: Path) -> None:
    """The max_tokens kwarg has to actually reach CompletionParams,
    not silently default to jig's adapter floor (4096) which truncates
    larger artifact rewrites mid-JSON. The default of 8192 — and any
    operator override — is load-bearing for cells where the artifact
    grows past a few KB."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='{"new_content": "x", "rationale": "y"}'
    )
    # Default: 8192.
    proposer = JigProposer(agent, llm=stub)
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub.last_params is not None
    assert stub.last_params.max_tokens == 8192

    # Override flows through.
    stub2 = _StubLLM(
        response_content='{"new_content": "x", "rationale": "y"}'
    )
    proposer2 = JigProposer(agent, llm=stub2, max_tokens=32000)
    await proposer2.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub2.last_params is not None
    assert stub2.last_params.max_tokens == 32000


async def test_propose_tolerates_missing_rationale(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='{"new_content": "x"}')
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "x"
    assert proposal.rationale == ""


async def test_propose_tolerates_whitespace_around_json(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='   \n{"new_content": "padded"}   \n'
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "padded"


# --- bound-agent invariant ----------------------------------------------


async def test_rejects_different_agent(tmp_path: Path) -> None:
    bound_agent = _agent(tmp_path)
    other_agent = Agent(
        name="bob",
        model="gpt-5",
        system_prompt="x",
        memory_db_path=tmp_path / "bob.db",
    )
    stub = _StubLLM(response_content='{"new_content": "x"}')
    proposer = JigProposer(bound_agent, llm=stub)
    with pytest.raises(ValueError, match="bound to agent"):
        await proposer.propose(
            agent=other_agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


# --- parse failures -----------------------------------------------------


async def test_parse_tolerates_fenced_json(tmp_path: Path) -> None:
    """Claude (in particular) tends to wrap structured output in a
    ```json ... ``` block even when the prompt forbids it. The parser
    strips a surrounding fence so the loop keeps moving without
    needing structured-output / tool-use plumbing in jig."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "```json\n"
            '{"new_content": "fenced content", "rationale": "ok"}\n'
            "```"
        )
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "fenced content"
    assert proposal.rationale == "ok"


async def test_parse_tolerates_fenced_json_no_language_tag(
    tmp_path: Path,
) -> None:
    """Bare ``` fence (no `json` lang tag) is also stripped."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='```\n{"new_content": "bare fence"}\n```'
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "bare fence"


async def test_parse_failure_on_prose_then_fence(tmp_path: Path) -> None:
    """Leading prose followed by a fenced block is treated as
    malformed — that's a prompt-tuning problem, not a formatting
    quirk to absorb. The parser only strips when the whole response
    is one fenced block."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "Here's my proposal:\n"
            "```json\n"
            '{"new_content": "x"}\n'
            "```"
        )
    )
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProposerOutputParseError, match="not valid JSON"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_context_appears_in_system_prompt(tmp_path: Path) -> None:
    """Non-empty `context` is prepended to the system prompt under a
    'What you bring to this project' header so the model sees the
    agent's prior memory at the top of every propose call."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='{"new_content": "x", "rationale": "y"}'
    )
    proposer = JigProposer(
        agent,
        llm=stub,
        context="- you tend to over-explain\n- prior project shipped late",
    )
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub.last_params is not None
    system = stub.last_params.system or ""
    assert "What you bring to this project" in system
    assert "you tend to over-explain" in system
    assert "prior project shipped late" in system


async def test_empty_context_leaves_prompt_unchanged(tmp_path: Path) -> None:
    """Default ``context=''`` keeps the system prompt unchanged — no
    empty 'What you bring' section, no behavioral change for callers
    who haven't wired a peer_context_loader."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='{"new_content": "x", "rationale": "y"}'
    )
    proposer = JigProposer(agent, llm=stub)  # context defaults to ""
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub.last_params is not None
    system = stub.last_params.system or ""
    assert "What you bring" not in system


async def test_parse_failure_on_non_json(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content="this is not JSON at all")
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProposerOutputParseError, match="not valid JSON"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_top_level_is_array(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='["new_content", "x"]')
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProposerOutputParseError, match="must be a JSON object"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_missing_new_content(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='{"rationale": "no content here"}')
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProposerOutputParseError, match="missing required"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_new_content_is_not_string(
    tmp_path: Path,
) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='{"new_content": 42}')
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProposerOutputParseError, match="must be a string"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_rationale_is_not_string(
    tmp_path: Path,
) -> None:
    """A non-string `rationale` would otherwise pass through silently
    and undermine the `malformed output raises` contract."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content='{"new_content": "x", "rationale": {"nested": "obj"}}'
    )
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(
        ProposerOutputParseError, match="rationale.*must be a string"
    ):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_drops_unexpected_top_level_keys(tmp_path: Path) -> None:
    """Extra top-level keys the model emits don't sneak through."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            '{"new_content": "x", "rationale": "ok", '
            '"extra_field": "should not appear"}'
        )
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    # Only new_content + rationale make it onto the Proposal; extra
    # keys don't get attached anywhere downstream.
    assert proposal.new_content == "x"
    assert proposal.rationale == "ok"


# --- prompt assembly ----------------------------------------------------


async def test_system_prompt_includes_frame_when_set(tmp_path: Path) -> None:
    agent = _agent(tmp_path, frame="precision")
    stub = _StubLLM(response_content='{"new_content": "x"}')
    proposer = JigProposer(agent, llm=stub)
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub.last_params is not None
    assert stub.last_params.system is not None
    assert "precision" in stub.last_params.system


async def test_user_message_includes_peer_proposals(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='{"new_content": "x"}')
    proposer = JigProposer(agent, llm=stub)
    peer_a = Proposal(
        agent_id="peer-a",
        based_on_version="v0",
        new_content="peer a's draft",
    )
    peer_b = Proposal(
        agent_id="peer-b",
        based_on_version="v0",
        new_content="peer b's draft",
    )
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
        peer_proposals=[peer_a, peer_b],
    )
    assert stub.last_params is not None
    user_msg = stub.last_params.messages[0].content
    assert "peer-a" in user_msg
    assert "peer-b" in user_msg
    assert "peer a's draft" in user_msg
    assert "peer b's draft" in user_msg


async def test_user_message_omits_peer_section_when_no_peers(
    tmp_path: Path,
) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content='{"new_content": "x"}')
    proposer = JigProposer(agent, llm=stub)
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
        peer_proposals=None,
    )
    assert stub.last_params is not None
    user_msg = stub.last_params.messages[0].content
    assert "Peer proposals" not in user_msg


# --- factory helper -----------------------------------------------------


async def test_make_proposers_keys_by_agent_id(tmp_path: Path) -> None:
    agents = [
        Agent(
            name=f"agent-{i}",
            model="claude-sonnet-4-5",
            system_prompt="x",
            memory_db_path=tmp_path / f"a-{i}.db",
        )
        for i in range(3)
    ]
    overrides = {
        a.id: _StubLLM(response_content='{"new_content": "x"}') for a in agents
    }
    proposers = make_proposers(agents, llm_overrides=overrides)
    assert set(proposers.keys()) == {a.id for a in agents}
    for agent in agents:
        assert proposers[agent.id].agent.id == agent.id
