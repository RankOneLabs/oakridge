"""Tests for the real jig-backed Proposer.

Uses a stub :class:`LLMClient` (injected via the ``llm`` kwarg) so
tests don't make real API calls. Covers:

- Happy path: stub returns sentinel-tagged output, propose() yields
  the expected :class:`Proposal`.
- Bound-agent invariant: passing a different agent to a
  :class:`JigProposer` raises.
- Parse failure paths: missing required tag, empty tag content.
- Tolerance: surrounding prose, markdown framing, literal double
  quotes inside tags (the bug class that motivated the sentinel-tag
  switch from the prior JSON envelope).
- System-prompt assembly: frame appended when present.
- User-message assembly: peer proposals included when supplied.
"""
from __future__ import annotations

import os
from pathlib import Path

import pytest
from jig.core.errors import JigLLMError
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
    ProviderIORetryExhausted,
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


class _SequencedStubLLM(LLMClient):
    """Returns a different canned response per call. Used by retry
    tests to simulate a model that violates the protocol on attempt
    N then recovers on N+1."""

    def __init__(self, response_contents: list[str]) -> None:
        self._contents = list(response_contents)
        self.call_count = 0

    async def complete(self, params: CompletionParams) -> LLMResponse:
        if self.call_count >= len(self._contents):
            raise AssertionError(
                f"_SequencedStubLLM exhausted after "
                f"{self.call_count} calls"
            )
        content = self._contents[self.call_count]
        self.call_count += 1
        return LLMResponse(
            content=content,
            tool_calls=None,
            usage=Usage(input_tokens=10, output_tokens=20),
            latency_ms=42.0,
            model="stub",
        )


def _tagged(new_content: str, rationale: str | None = None) -> str:
    """Build a sentinel-tag response body. Keeps tests readable."""
    parts = [
        f"<proposal_new_content>\n{new_content}\n</proposal_new_content>"
    ]
    if rationale is not None:
        parts.append(
            f"<proposal_rationale>\n{rationale}\n</proposal_rationale>"
        )
    return "\n".join(parts)


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


async def test_propose_returns_proposal_from_tags(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=_tagged(
            "the revised paragraph", rationale="tightened wording"
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
    larger artifact rewrites mid-output. The default of 8192 — and any
    operator override — is load-bearing for cells where the artifact
    grows past a few KB."""
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content=_tagged("x", rationale="y"))
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
    stub2 = _StubLLM(response_content=_tagged("x", rationale="y"))
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


async def test_propose_tolerates_missing_rationale_tag(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content=_tagged("x"))  # no rationale tag
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


async def test_propose_tolerates_whitespace_around_response(
    tmp_path: Path,
) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=f"   \n{_tagged('padded')}\n   \n"
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
    stub = _StubLLM(response_content=_tagged("x"))
    proposer = JigProposer(bound_agent, llm=stub)
    with pytest.raises(ValueError, match="bound to agent"):
        await proposer.propose(
            agent=other_agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


# --- tag tolerance (the motivating bug class) ---------------------------


async def test_parse_tolerates_unescaped_double_quotes_in_content(
    tmp_path: Path,
) -> None:
    """The motivating bug: prose artifacts citing papers with
    double-quoted titles (e.g., Yunkaporta '(Non-)Human Coordination
    Dynamics') tripped the prior JSON envelope when the model didn't
    escape inner quotes. Sentinel tags take content verbatim, so this
    must round-trip unchanged."""
    agent = _agent(tmp_path)
    artifact_with_quotes = (
        'See Yunkaporta et al.\'s "(Non-)Human Coordination Dynamics" '
        '(2026) for background. Other quoted strings: "hello", "world".'
    )
    stub = _StubLLM(
        response_content=_tagged(
            artifact_with_quotes, rationale="added citation"
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
    assert proposal.new_content == artifact_with_quotes


async def test_parse_tolerates_surrounding_prose(tmp_path: Path) -> None:
    """Models sometimes prepend framing prose (\"Here's my proposal:\")
    before the tags. Sentinel tags are unambiguous boundaries, so
    surrounding chatter is harmless — extract the tagged content and
    move on."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "Here's my proposal — I focused on tightening the opening:\n\n"
            f"{_tagged('the new artifact body', rationale='reordered')}"
            "\n\nLet me know if you'd like further revisions."
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
    assert proposal.new_content == "the new artifact body"
    assert proposal.rationale == "reordered"


async def test_parse_skips_preamble_mention_of_tag(
    tmp_path: Path,
) -> None:
    """If the model thinks aloud about the protocol — mentioning
    ``<proposal_new_content>`` (and even a stray closing tag) in a
    preamble before emitting the actual tagged block — the body's
    tempered-greedy match refuses to span a second opening tag, so
    the regex backtracks to start at the *real* tagged block. The
    preamble must not leak into ``new_content``."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "I'll wrap my proposal in <proposal_new_content> tags "
            "and close with </proposal_new_content> as instructed.\n\n"
            "Here it is:\n\n"
            f"{_tagged('real content', rationale='ok')}"
        ),
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "real content"
    assert proposal.rationale == "ok"


# --- parse failures -----------------------------------------------------


async def test_parse_failure_when_no_tags(tmp_path: Path) -> None:
    """Model returned plain prose with no sentinel tags."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content="Here's my draft, no tags around it."
    )
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(
        ProposerOutputParseError,
        match="missing required <proposal_new_content> tag",
    ):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_only_rationale_tag(tmp_path: Path) -> None:
    """Rationale tag alone isn't enough — new_content is required."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "<proposal_rationale>\nmy reasoning\n</proposal_rationale>"
        )
    )
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(
        ProposerOutputParseError,
        match="missing required <proposal_new_content> tag",
    ):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_failure_when_new_content_tag_is_empty(
    tmp_path: Path,
) -> None:
    """An empty new_content tag doesn't carry a real proposal."""
    agent = _agent(tmp_path)
    stub = _StubLLM(
        response_content=(
            "<proposal_new_content>\n   \n</proposal_new_content>"
        )
    )
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(
        ProposerOutputParseError, match="was empty"
    ):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )


async def test_parse_retry_recovers_after_first_violation(
    tmp_path: Path,
) -> None:
    """Default ``max_parse_retries=1``: a model that violates the
    protocol on attempt 1 then complies on attempt 2 should produce
    a clean Proposal. Two LLM calls were made; no error propagates.
    This is the common-case fix for stochastic protocol violations
    we see from weak open models."""
    agent = _agent(tmp_path)
    stub = _SequencedStubLLM(
        [
            "I'll just write the code:\n\ndef foo(): pass",
            _tagged("the real proposal", rationale="reasoned"),
        ]
    )
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "the real proposal"
    assert proposal.rationale == "reasoned"
    assert stub.call_count == 2


async def test_parse_retry_exhausts_and_raises(tmp_path: Path) -> None:
    """When EVERY attempt violates the protocol — including the final
    retry — the parse error propagates so the cell-level handler
    records cell_failed. Verifies the retry budget has a finite
    ceiling rather than looping forever."""
    agent = _agent(tmp_path)
    stub = _SequencedStubLLM(
        [
            "no tags here, attempt 1",
            "still no tags, attempt 2",
            "still no tags, attempt 3",
        ]
    )
    proposer = JigProposer(agent, llm=stub, max_parse_retries=2)
    with pytest.raises(
        ProposerOutputParseError,
        match="missing required <proposal_new_content> tag",
    ):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )
    # Three attempts: 1 initial + 2 retries.
    assert stub.call_count == 3


async def test_parse_retry_disabled_when_max_is_zero(
    tmp_path: Path,
) -> None:
    """``max_parse_retries=0`` restores the original one-shot
    behavior. A single violation propagates immediately; the LLM is
    only called once."""
    agent = _agent(tmp_path)
    stub = _SequencedStubLLM(
        [
            "no tags",
            _tagged("would succeed if we retried"),
        ]
    )
    proposer = JigProposer(agent, llm=stub, max_parse_retries=0)
    with pytest.raises(ProposerOutputParseError):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )
    assert stub.call_count == 1


def test_parse_retry_rejects_negative_budget(tmp_path: Path) -> None:
    """Negative retry budgets are nonsense — fail loud at construction
    rather than silently treating them as zero."""
    agent = _agent(tmp_path)
    with pytest.raises(
        ValueError, match="max_parse_retries must be non-negative"
    ):
        JigProposer(
            agent,
            llm=_StubLLM(_tagged("x")),
            max_parse_retries=-1,
        )


async def test_parse_failure_writes_debug_dump_when_env_set(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When ``LBC_PROPOSER_DEBUG_DIR`` is set, a parse failure writes
    a ``parse-fail-<ts>.txt`` dump to that directory containing the
    failure reason and the raw model output. Created with mode 0o600
    on POSIX so the dump (which can hold sensitive artifact content)
    isn't readable by other users on shared hosts."""
    debug_dir = tmp_path / "debug-dumps"
    monkeypatch.setenv("LBC_PROPOSER_DEBUG_DIR", str(debug_dir))

    agent = _agent(tmp_path)
    stub = _StubLLM(response_content="no tags here")
    # max_parse_retries=0 so the parse fails on the first (only)
    # attempt — we want to assert the dump-creation contract for
    # ONE failed parse, not the cumulative behavior of N retries.
    # Retry-induced multi-dump behavior has its own coverage in the
    # parse-retry tests above.
    proposer = JigProposer(agent, llm=stub, max_parse_retries=0)

    with pytest.raises(ProposerOutputParseError):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )

    dumps = list(debug_dir.glob("parse-fail-*.txt"))
    assert len(dumps) == 1
    body = dumps[0].read_text(encoding="utf-8")
    assert "missing <proposal_new_content> sentinel tag" in body
    assert "no tags here" in body

    if os.name == "posix":
        assert (dumps[0].stat().st_mode & 0o777) == 0o600


# --- prompt assembly ----------------------------------------------------


async def test_context_appears_in_system_prompt(tmp_path: Path) -> None:
    """Non-empty `context` is prepended to the system prompt under a
    'What you bring to this project' header so the model sees the
    agent's prior memory at the top of every propose call."""
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content=_tagged("x", rationale="y"))
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
    stub = _StubLLM(response_content=_tagged("x", rationale="y"))
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


async def test_system_prompt_includes_frame_when_set(tmp_path: Path) -> None:
    agent = _agent(tmp_path, frame="precision")
    stub = _StubLLM(response_content=_tagged("x"))
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


async def test_system_prompt_advertises_sentinel_tags(tmp_path: Path) -> None:
    """The system prompt has to actually instruct the model to use the
    sentinel tags — otherwise models default to JSON or plain prose
    and the parser raises. Smoke-check the tag names are present."""
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content=_tagged("x"))
    proposer = JigProposer(agent, llm=stub)
    await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert stub.last_params is not None
    system = stub.last_params.system or ""
    assert "<proposal_new_content>" in system
    assert "</proposal_new_content>" in system


async def test_user_message_includes_peer_proposals(tmp_path: Path) -> None:
    agent = _agent(tmp_path)
    stub = _StubLLM(response_content=_tagged("x"))
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
    stub = _StubLLM(response_content=_tagged("x"))
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


# --- IO retry (provider transport failures) --------------------------------


class _FaultSequencedLLM(LLMClient):
    """Returns errors or canned responses per call in sequence. Each
    entry in ``sequence`` is either a string (canned response content)
    or a ``JigLLMError`` instance to raise."""

    def __init__(self, sequence: list[str | JigLLMError]) -> None:
        self._sequence = list(sequence)
        self.call_count = 0

    async def complete(self, params: CompletionParams) -> LLMResponse:
        if self.call_count >= len(self._sequence):
            raise AssertionError(
                f"_FaultSequencedLLM exhausted after {self.call_count} calls"
            )
        item = self._sequence[self.call_count]
        self.call_count += 1
        if isinstance(item, JigLLMError):
            raise item
        return LLMResponse(
            content=item,
            tool_calls=None,
            usage=Usage(input_tokens=10, output_tokens=20),
            latency_ms=42.0,
            model="stub",
        )


async def _instant_sleep(_: float) -> None:
    """Stub for asyncio.sleep that returns immediately."""


async def test_io_retry_recovers_after_retryable_provider_error(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """A retryable JigLLMError on the first attempt is silently retried.
    The second attempt succeeds and produce() returns the Proposal.
    Two LLM calls were made; no error propagates."""
    monkeypatch.setattr(
        "legit_biz_club.coordination.jig_proposer.asyncio.sleep",
        _instant_sleep,
    )
    agent = _agent(tmp_path)
    retryable_err = JigLLMError(
        "service unavailable", provider="anthropic", status_code=503, retryable=True
    )
    stub = _FaultSequencedLLM([retryable_err, _tagged("recovered proposal", rationale="ok")])
    proposer = JigProposer(agent, llm=stub)
    proposal = await proposer.propose(
        agent=agent,
        brief=_brief(),
        artifact=_artifact(tmp_path),
        current_content="seed",
        current_version="v0",
    )
    assert proposal.new_content == "recovered proposal"
    assert stub.call_count == 2


async def test_io_retry_exhausted_raises_provider_io_retry_exhausted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    """When all IO attempts fail with retryable errors, ProviderIORetryExhausted
    is raised with structured fields (attempt count, error class/message,
    operation, agent_id). The retry budget has a finite ceiling."""
    monkeypatch.setattr(
        "legit_biz_club.coordination.jig_proposer.asyncio.sleep",
        _instant_sleep,
    )
    agent = _agent(tmp_path)
    retryable_err = JigLLMError(
        "rate limited", provider="anthropic", status_code=429, retryable=True
    )
    stub = _FaultSequencedLLM([retryable_err, retryable_err, retryable_err])
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(ProviderIORetryExhausted) as exc_info:
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )
    err = exc_info.value
    assert err.attempts == 2  # _IO_RETRY_MAX_ATTEMPTS = 2
    assert err.last_error_class == "JigLLMError"
    assert "rate limited" in err.last_error_message
    assert err.operation == "llm_complete"
    assert err.agent_id == agent.id
    assert stub.call_count == 2  # only used _IO_RETRY_MAX_ATTEMPTS attempts


async def test_io_retry_does_not_retry_non_retryable_provider_error(
    tmp_path: Path,
) -> None:
    """A JigLLMError with retryable=False is a permanent failure (auth,
    bad request). It must propagate immediately without any retries."""
    agent = _agent(tmp_path)
    perm_err = JigLLMError(
        "invalid api key", provider="anthropic", status_code=401, retryable=False
    )
    stub = _FaultSequencedLLM([perm_err, _tagged("would succeed")])
    proposer = JigProposer(agent, llm=stub)
    with pytest.raises(JigLLMError, match="invalid api key"):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )
    assert stub.call_count == 1  # no retry


async def test_parse_error_is_not_retried_as_io_error(
    tmp_path: Path,
) -> None:
    """Parse failures (missing sentinel tags) must not trigger IO
    retries. IO retries are only for transient transport failures;
    retrying a parse error would repeat the same invalid model output
    and mask a deterministic contract violation."""
    agent = _agent(tmp_path)
    stub = _SequencedStubLLM(
        [
            "no tags — this is a parse failure",
            _tagged("valid response that would succeed if IO-retried"),
        ]
    )
    # max_parse_retries=0 to isolate: ONE attempt, parse fails → error.
    # If IO retry fired on parse failure we'd consume two calls.
    proposer = JigProposer(agent, llm=stub, max_parse_retries=0)
    with pytest.raises(ProposerOutputParseError):
        await proposer.propose(
            agent=agent,
            brief=_brief(),
            artifact=_artifact(tmp_path),
            current_content="seed",
            current_version="v0",
        )
    assert stub.call_count == 1  # IO retry must not have fired


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
        a.id: _StubLLM(response_content=_tagged("x")) for a in agents
    }
    proposers = make_proposers(agents, llm_overrides=overrides)
    assert set(proposers.keys()) == {a.id for a in agents}
    for agent in agents:
        assert proposers[agent.id].agent.id == agent.id
