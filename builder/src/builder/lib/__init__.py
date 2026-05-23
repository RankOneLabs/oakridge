"""Pure helpers extracted from builder handlers.

Modules in this package contain logic with no IO and no LLM calls — they
exist so the handler files (planner2, review responders, pipeline) stay
focused on orchestration and can be unit-tested in isolation per
backend.md.
"""
