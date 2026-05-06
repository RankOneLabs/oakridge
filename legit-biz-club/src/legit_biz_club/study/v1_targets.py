"""Concrete v1 study targets — real briefs for cells we actually run.

Per the design memo's two-domain v1 test:

- Prose domain: a technical blog post explaining the multi-agent
  workspace architecture itself. The brief carries the architecture
  facts inline so models don't fall back on training-data priors and
  invent coordination modes the system doesn't have.
- Code domain: a leetcode-shaped problem (longest substring without
  repeating characters). Well-specified, narrow scope, easy to eval
  mechanically once we wire a grader.

Generic :func:`legit_biz_club.study.targets.prose_target` and
:func:`legit_biz_club.study.targets.code_target` stay as the API
templates with placeholder defaults — useful for harness tests.
This module supplies the real targets with the real briefs the v1
study runs against.
"""
from __future__ import annotations

from legit_biz_club.core.models import Brief
from legit_biz_club.study.targets import (
    TargetConfig,
    code_target,
    prose_target,
)

# --- prose: substrate-mediated coordination thesis -----------------------


_PROSE_SUBSTRATE_THESIS_TARGET_SPEC = (
    "Draft a technical blog post (1200-1800 words) explaining "
    "oakridge's multi-agent workspace architecture to senior "
    "software engineers.\n\n"
    "The architecture is described below. Do NOT invent additional "
    "coordination modes, components, or features beyond what's "
    "stated.\n\n"
    "## The thesis\n"
    "Substrate-mediated coordination: a small group of agents "
    "(default 5) works on a shared artifact, each agent reading "
    "the artifact's current state and proposing changes. Agents "
    "do not message each other — they read substrate, propose, "
    "and a project layer mediates. Coordination cost stays "
    "roughly constant as group size grows; direct-messaging "
    "architectures grow O(N²).\n\n"
    "## Three layers\n"
    "- Agent: long-lived, persistent, has its own model + system "
    "prompt + accumulating memory across projects.\n"
    "- Project: bounded context, owns one artifact + one brief + "
    "one enrolled ensemble. Lifecycle: spawn → enroll → iterate "
    "→ ship/archive.\n"
    "- Workspace: operator control plane.\n\n"
    "## Three coordination modes\n"
    "- Incremental commits (default): agents take turns proposing "
    "changes to the artifact. Mediator applies via OCC; conflicts "
    "get a retry budget. Termination: K commits per agent OR "
    "content stability.\n"
    "- Convergence rounds: when triggered by project config, the "
    "mechanism runs N rounds of 'all agents propose, peer "
    "proposals exposed as substrate next round.' Two "
    "implementations: multi-round (default) and "
    "single-round-then-pick.\n"
    "- Escalation: if rounds don't converge, a DisagreementSurface "
    "picks a winner from residual proposals. Default surface is "
    "automated (deterministic stable-ordering by agent_id); "
    "operator-in-loop is optional.\n\n"
    "## Influences (cite honestly)\n"
    "- Hayes-Roth blackboard architecture (1985) — closest direct "
    "ancestor: knowledge sources reading/writing shared workspace, "
    "no inter-source messaging.\n"
    "- Yunkaporta et al. '(Non-)Human Coordination Dynamics' "
    "(2026) — crystallized peer-collaboration-via-shared-substrate "
    "as the architectural pattern."
)


def prose_substrate_thesis() -> TargetConfig:
    """Real prose target for the v1 study: the architecture thesis post.

    The brief is deliberately long because it has to crowd out the
    model's training-data priors about multi-agent systems. Earlier
    smoke runs against the placeholder brief produced plausible-but-
    wrong invented modes (sequential / parallel / hierarchical, etc.);
    shipping the architecture facts in-line is the simplest fix.

    The :class:`Brief` is built fresh per call: pydantic models'
    list fields (success_criteria, constraints) are mutable, and a
    cached module-level Brief would let an in-place mutation by one
    caller leak to every subsequent caller. Module-level constants
    are limited to immutable strings.

    Default model_pool inherits from :func:`prose_target` (Anthropic +
    OpenAI + Google spread). Override at the call site to pin to one
    provider during cost-conscious smoke runs.
    """
    brief = Brief(
        target_spec=_PROSE_SUBSTRATE_THESIS_TARGET_SPEC,
        success_criteria=[
            "explains the substrate-mediated coordination thesis "
            "clearly to a software engineer with no prior context",
            "names the three coordination modes accurately "
            "(incremental, convergence, escalation) — does NOT "
            "invent others",
            "includes at least one concrete example (a project run, "
            "code fragment, or worked scenario)",
            "cites the blackboard ancestor and the Yunkaporta paper",
            "is 1200-1800 words",
            "reads as a technical blog post, not marketing copy",
        ],
        constraints=[
            "no marketing language",
            "no invented architectures (sequential / parallel / "
            "hierarchical are NOT modes in this system)",
            "no fictional code APIs — if you show code, show "
            "pseudocode or explicitly-marked illustrative examples",
        ],
    )
    return prose_target(
        name="prose_substrate_thesis",
        artifact_filename="thesis.md",
        seed_content="",
        brief=brief,
    )


# --- code: leetcode #3 (longest substring without repeating chars) -------


_CODE_LEETCODE_LONGEST_SUBSTRING_TARGET_SPEC = (
    "Implement `length_of_longest_substring(s: str) -> int` in "
    "solution.py.\n\n"
    "Given a string s, return the length of the longest substring "
    "without repeating characters.\n\n"
    "Examples:\n"
    "  'abcabcbb' → 3  (longest: 'abc')\n"
    "  'bbbbb'    → 1  (longest: 'b')\n"
    "  'pwwkew'   → 3  (longest: 'wke')\n"
    "  ''         → 0\n"
    "  'au'       → 2\n"
    "  ' '        → 1  (single space is one character)\n"
    "  'dvdf'     → 3  (longest: 'vdf')\n\n"
    "The function must:\n"
    "  - Accept any string including empty, single-character, or "
    "whitespace\n"
    "  - Return 0 for empty input\n"
    "  - Be case-sensitive ('Aa' → 2)\n"
    "  - Treat Unicode characters as single units\n\n"
    "Recommended approach: O(n) sliding window with a dict mapping "
    "character → last-seen index. Brute force O(n²) also "
    "acceptable as long as results are correct."
)


_CODE_LEETCODE_LONGEST_SUBSTRING_SEED = (
    "def length_of_longest_substring(s: str) -> int:\n"
    "    raise NotImplementedError\n"
)


def code_leetcode_longest_substring() -> TargetConfig:
    """Real code target for the v1 study: leetcode #3.

    Sliding-window classic — well-specified, narrow scope, easy to
    eval mechanically once we wire a grader. Multiple correct
    approaches (sliding-window vs brute force) so ensemble runs have
    real differential signal between agents.

    The seed is just a function stub raising NotImplementedError so
    the artifact starts in a known-broken state — agents have to
    actually produce a working implementation, not just decorate
    a placeholder.

    Brief is built fresh per call (same rationale as
    :func:`prose_substrate_thesis`): pydantic models' list fields
    are mutable, and module-level caching would let one caller's
    in-place mutation leak to all later callers.
    """
    brief = Brief(
        target_spec=_CODE_LEETCODE_LONGEST_SUBSTRING_TARGET_SPEC,
        success_criteria=[
            "function passes all 7 example test cases above",
            "type-checks under strict mypy (no Any in the function "
            "signature)",
            "passes ruff lint with project defaults",
            "runtime is O(n) or O(n²) — no worse",
        ],
        constraints=[
            "single file, single function — no helper classes",
            "no third-party imports (typing is fine)",
            "no comments inside the function unless they explain a "
            "non-obvious algorithmic choice",
        ],
    )
    return code_target(
        name="code_leetcode_longest_substring",
        artifact_filename="solution.py",
        seed_content=_CODE_LEETCODE_LONGEST_SUBSTRING_SEED,
        brief=brief,
    )
