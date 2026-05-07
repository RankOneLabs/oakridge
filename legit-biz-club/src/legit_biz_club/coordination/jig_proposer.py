"""Real LLM-backed Proposer that wraps jig's ``LLMClient``.

Replaces the stub Proposer used in the incremental-coordination tests
with a production-shaped path. One :class:`JigProposer` per enrolled
agent — instances are bound to a single :class:`Agent` and dispatch
``LLMClient`` based on ``agent.model`` via :func:`jig.llm.factory.from_model`.

Output parsing: the proposer instructs the model to return its
proposal inside ``<proposal_new_content>...</proposal_new_content>``
and ``<proposal_rationale>...</proposal_rationale>`` tags and extracts
the contents into a :class:`Proposal`. Sentinel-tag transport (vs an
earlier JSON envelope) sidesteps the worst Claude failure mode for
prose targets: artifacts containing literal double quotes (paper
titles, dialogue, code samples) routinely tripped the JSON parser
when the model didn't escape them, and that error class is
intentionally non-retryable. Tag-bounded content is verbatim — no
escaping required — which removes the entire failure mode.

Tests inject a stub :class:`LLMClient` to avoid real API calls. The
:func:`make_proposers` helper constructs one :class:`JigProposer` per
agent in a list and returns the dict the coordinator wants.
"""
from __future__ import annotations

import logging
import os
import re
from collections.abc import Sequence
from datetime import UTC, datetime
from pathlib import Path

from jig.core.types import CompletionParams, LLMClient, Message, Role
from jig.llm.factory import from_model

from legit_biz_club.coordination.proposal import Proposal
from legit_biz_club.core.models import Agent, Artifact, Brief

logger = logging.getLogger(__name__)


# Opt-in diagnostic for parse failures. When set to a writable
# directory path, sentinel-tag-extraction failures dump the raw LLM
# output to ``<dir>/parse-fail-<ts>.txt`` so the operator can inspect
# what the model actually emitted (e.g., omitted tags, mismatched
# closing tags, content placed outside the tags). Default off —
# artifact content may be sensitive; the warning log line (length +
# error detail) is enough for most diagnostics.
_PROPOSER_DEBUG_DIR_ENV = "LBC_PROPOSER_DEBUG_DIR"


def _maybe_dump_failed_output(raw: str, reason: str) -> None:
    debug_dir = os.environ.get(_PROPOSER_DEBUG_DIR_ENV)
    if not debug_dir:
        return
    target = Path(debug_dir)
    try:
        target.mkdir(parents=True, exist_ok=True)
        ts = datetime.now(UTC).strftime("%Y-%m-%dT%H-%M-%S-%fZ")
        out = target / f"parse-fail-{ts}.txt"
        # 0o600 at create time so the dump (which can contain raw
        # artifact content) isn't readable by other users on shared
        # hosts. Process umask alone isn't enough — be explicit.
        fd = os.open(
            out, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600
        )
        with os.fdopen(fd, "w", encoding="utf-8") as fh:
            fh.write(
                f"--- reason: {reason}\n"
                f"--- raw_length: {len(raw)}\n"
                f"--- raw output ---\n"
                f"{raw}\n"
                f"--- end raw ---\n"
            )
        logger.warning(
            "proposer parse-failure dump written to %s", out
        )
    except OSError as dump_err:
        # Diagnostic shouldn't ever crash the harness — if the dump
        # write fails, the parse error still propagates with its
        # original detail.
        logger.warning(
            "failed to write proposer parse-failure dump to %s: %s",
            target,
            dump_err,
        )


_OUTPUT_INSTRUCTIONS = """\

When you respond, place your proposal inside these tags:

<proposal_new_content>
The full proposed next version of the artifact, exactly as it should
appear. Write the content verbatim — no escaping, no formatting
transformations. Whatever is between the tags becomes the artifact.
</proposal_new_content>
<proposal_rationale>
One or two sentences explaining what you changed and why.
</proposal_rationale>

The rationale tag is optional but recommended. Do not place anything
inside the new_content tag that isn't part of the artifact itself.
"""


class ProposerOutputParseError(ValueError):
    """The agent's response did not contain the expected sentinel tags.

    Surfaces as a hard failure rather than a recoverable one because
    a Proposer that can't follow the tag protocol isn't going to
    self-correct via retry — prompt-tuning is the right response.
    """


class JigProposer:
    """Production :class:`Proposer` implementation. One instance per agent."""

    def __init__(
        self,
        agent: Agent,
        *,
        llm: LLMClient | None = None,
        context: str = "",
        max_tokens: int = 8192,
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
        # Output-token cap for the underlying LLM call. The proposer's
        # whole-artifact-in-JSON shape means output tokens scale with
        # artifact size — a 1500-word prose target round-trips through
        # JSON as ~3000 tokens, more once peer proposals get echoed
        # back in the rationale. jig's adapter default (4096) hits the
        # cap mid-artifact for ensemble cells where the artifact grows
        # past commit #3 or #4. 8192 is comfortably above that floor
        # and below every modern Claude model's per-call cap; bump
        # higher for richer artifacts or longer rounds.
        self._max_tokens = max_tokens
        # Per-project peer context — what the agent brings into this
        # project from prior memory. Loaded by the harness via a
        # PeerContextLoader (operator-supplied) and added to the
        # system prompt as a stanza after the agent's identity prompt
        # (and optional frame), before the JSON output instructions.
        # Empty / whitespace-only string = no context section, prompt
        # is unchanged. The proposer is intentionally agnostic about
        # how this string was assembled (SqliteStore observations,
        # honcho deriver query, hand-curated text, etc.) — that's the
        # loader's job.
        self._context = context

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
            max_tokens=self._max_tokens,
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
        if self._context.strip():
            parts.append(
                "\n# What you bring to this project\n"
                f"{self._context.rstrip()}"
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
            "Produce the next version of the artifact. Wrap your "
            "proposal in the sentinel tags specified in your system "
            "prompt."
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


# Sentinel tags. Distinct, lowercase-with-underscore names that
# won't collide with anything a real artifact would plausibly contain
# (markdown, prose, code samples, citations). Two regex defenses
# against models that mention the protocol in a preamble before
# emitting the real proposal:
#   1. The body is a tempered-greedy ``(?:(?!<open>).)*`` rather than
#      plain ``.*?`` so the body can't span a second opening tag —
#      important when a preamble has only the *opening* tag mentioned
#      (no matching close) and the real block comes later.
#   2. ``_parse_response`` picks the *last* finditer match rather than
#      the first — covers preambles that include both an opening AND
#      closing mention before the real tagged block. Real proposals
#      always come last in normal model output.
# Together these handle both common preamble shapes. The regex still
# can't disambiguate an artifact that contains the literal sentinel
# string, but study artifacts mentioning the harness's own protocol
# tags are far less likely than models thinking-aloud about the
# prompt before responding.
_NEW_CONTENT_RE = re.compile(
    r"<proposal_new_content>"
    r"(?P<body>(?:(?!<proposal_new_content>).)*)"
    r"</proposal_new_content>",
    re.DOTALL,
)
_RATIONALE_RE = re.compile(
    r"<proposal_rationale>"
    r"(?P<body>(?:(?!<proposal_rationale>).)*)"
    r"</proposal_rationale>",
    re.DOTALL,
)


def _parse_response(content: str) -> dict[str, str]:
    """Extract proposal content from sentinel tags in the LLM response.

    Looks for ``<proposal_new_content>...</proposal_new_content>``
    (required) and ``<proposal_rationale>...</proposal_rationale>``
    (optional) anywhere in the response. Surrounding prose, markdown
    fences, or framing text from the model are tolerated — the tags
    are unambiguous boundaries, so leading/trailing chatter doesn't
    corrupt extraction.

    Returns a normalized dict: ``{"new_content": ..., "rationale": ...}``
    where ``rationale`` is only present when the rationale tag was
    found and non-empty.

    Sentinel-tag transport replaced an earlier JSON-envelope shape
    that consistently failed on prose artifacts containing literal
    double quotes (paper titles, dialogue) — JSON requires escaping
    those, and models routinely don't. Tag-bounded content is taken
    verbatim, sidestepping that entire failure class.
    """
    # finditer + take-last so a preamble that mentions both opening
    # and closing tags before the real proposal doesn't capture the
    # preamble (see regex docstring above). For normal single-block
    # outputs, this is equivalent to a single search.
    new_matches = list(_NEW_CONTENT_RE.finditer(content))
    if not new_matches:
        reason = "missing <proposal_new_content> sentinel tag"
        logger.warning(
            "proposer parse failed (length=%d): %s",
            len(content),
            reason,
        )
        _maybe_dump_failed_output(content, reason)
        raise ProposerOutputParseError(
            f"agent response was missing required "
            f"<proposal_new_content> tag (response length={len(content)})"
        )
    new_match = new_matches[-1]
    # Strip only the single framing newline adjacent to each tag.
    # Models reliably emit the tag block as ``<tag>\nbody\n</tag>``
    # for legibility — those newlines are formatting, not artifact
    # content. Keep everything else verbatim so artifacts that rely
    # on internal whitespace, indentation, or a trailing newline
    # (e.g., code, poetry, files where W292 matters) round-trip
    # unchanged. ``str.removeprefix`` / ``str.removesuffix`` only
    # strip a single occurrence each, which is exactly what we want.
    new_content = (
        new_match.group("body").removeprefix("\n").removesuffix("\n")
    )
    if not new_content.strip():
        reason = "<proposal_new_content> tag was empty"
        logger.warning(
            "proposer parse failed (length=%d): %s",
            len(content),
            reason,
        )
        _maybe_dump_failed_output(content, reason)
        raise ProposerOutputParseError(reason)
    normalized: dict[str, str] = {"new_content": new_content}
    rationale_matches = list(_RATIONALE_RE.finditer(content))
    if rationale_matches:
        rationale = (
            rationale_matches[-1]
            .group("body")
            .removeprefix("\n")
            .removesuffix("\n")
        )
        if rationale.strip():
            normalized["rationale"] = rationale
    return normalized
