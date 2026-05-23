"""CLI entry point for the review responder subprocess.

Called by kbbl's review-responder-consumer.ts as:
  python -m builder.review_responder_runner \\
    --target-type <plan|build_brief> \\
    --target-id <id> \\
    --thread-id <id> \\
    --safir-base-url <url>

The full ReviewResponderContext JSON is read from stdin. The result is
written as a single JSONL line to stdout: {status, reply_message_id?, error?,
conflicts: [...]}.
"""
from __future__ import annotations

import argparse
import asyncio
import json
import sys
import traceback

from safir_py import SafirClient, safir_api_token_from_env

from .build_brief_review_responder import run_build_brief_review_responder
from .plan_review_responder import run_plan_review_responder
from .review_responder_base import ResponderResult, ReviewResponderContext


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Run a review responder agent and emit JSONL result."
    )
    parser.add_argument(
        "--target-type",
        required=True,
        choices=["plan", "build_brief"],
    )
    parser.add_argument("--target-id", required=True)
    parser.add_argument("--thread-id", required=True)
    parser.add_argument("--safir-base-url", required=True)
    return parser.parse_args()


async def _run(args: argparse.Namespace, ctx: ReviewResponderContext) -> ResponderResult:
    client = SafirClient(
        base_url=args.safir_base_url,
        api_token=safir_api_token_from_env(),
    )
    try:
        if args.target_type == "plan":
            return await run_plan_review_responder(ctx=ctx, client=client)
        else:
            return await run_build_brief_review_responder(ctx=ctx, client=client)
    finally:
        await client.aclose()


def main() -> None:
    args = _parse_args()
    try:
        ctx_data = json.load(sys.stdin)
        ctx = ReviewResponderContext.model_validate(ctx_data)
    except Exception as exc:
        result = ResponderResult(
            status="failed",
            error=f"failed to parse context payload: {exc}",
        )
        print(json.dumps(result.model_dump()), flush=True)
        sys.exit(1)

    if (
        ctx.target_type != args.target_type
        or ctx.target_id != args.target_id
        or ctx.thread_id != args.thread_id
    ):
        result = ResponderResult(
            status="failed",
            error=(
                f"context/CLI mismatch: "
                f"ctx=({ctx.target_type},{ctx.target_id},{ctx.thread_id}) "
                f"args=({args.target_type},{args.target_id},{args.thread_id})"
            ),
        )
        print(json.dumps(result.model_dump()), flush=True)
        sys.exit(1)

    try:
        result = asyncio.run(_run(args, ctx))
    except Exception:
        tb = traceback.format_exc()
        result = ResponderResult(
            status="failed",
            error=f"runner exception: {tb[-500:]}",
        )

    print(json.dumps(result.model_dump()), flush=True)


if __name__ == "__main__":
    main()
