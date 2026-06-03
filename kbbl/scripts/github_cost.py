#!/usr/bin/env python3
"""Estimate Claude Code spend attributable to GitHub interactions.

Reads Claude Code session transcripts (JSONL under ~/.claude/projects/<proj>/),
prices every assistant turn at standard API rates, and tags turns that issue a
GitHub interaction (gh / git Bash commands, WebFetch to github.com, the ghreview
skill). Reports total spend plus two attribution bounds and a per-command-type
breakdown.

Attribution is bounded, not exact — see the README block printed by --explain.

Usage:
  python3 github_cost.py                      # all projects, summary to stdout
  python3 github_cost.py --filter oakridge    # only project dirs matching substring
  python3 github_cost.py --since 2026-05-01   # turns on/after date (UTC)
  python3 github_cost.py --until 2026-06-01   # turns before date
  python3 github_cost.py --json out.json      # machine-readable dump
  python3 github_cost.py --csv-commands cmds.csv   # per-command-type table as CSV
  python3 github_cost.py --explain            # print methodology and exit
"""
import argparse, json, glob, os, re
from collections import defaultdict
from datetime import datetime

# --- Pricing (USD per 1M tokens), standard tier. Keyed by model-name substring. ---
PRICING = {
    "opus":   dict(inp=15.0, out=75.0, cw5=18.75, cw1=30.0, cr=1.50),
    "sonnet": dict(inp=3.0,  out=15.0, cw5=3.75,  cw1=6.0,  cr=0.30),
    "haiku":  dict(inp=1.0,  out=5.0,  cw5=1.25,  cw1=2.0,  cr=0.10),
}
DEFAULT_PRICE = PRICING["sonnet"]  # fallback for unrecognized models


def price_for(model):
    m = (model or "").lower()
    for key, p in PRICING.items():
        if key in m:
            return p
    return DEFAULT_PRICE


def turn_cost(usage, model):
    """Full priced cost of one assistant turn from its usage block (USD)."""
    if not usage:
        return 0.0
    p = price_for(model)
    cc = usage.get("cache_creation") or {}
    c5 = cc.get("ephemeral_5m_input_tokens", 0)
    c1 = cc.get("ephemeral_1h_input_tokens", 0)
    if not (c5 or c1):  # older records: flat field, treat as 5m write
        c5 = usage.get("cache_creation_input_tokens", 0)
    return (
        usage.get("input_tokens", 0) * p["inp"]
        + usage.get("output_tokens", 0) * p["out"]
        + c5 * p["cw5"]
        + c1 * p["cw1"]
        + usage.get("cache_read_input_tokens", 0) * p["cr"]
    ) / 1_000_000


def output_cost(usage, model):
    """Cost of just the output tokens (the model 'deciding + writing' the call)."""
    if not usage:
        return 0.0
    return usage.get("output_tokens", 0) * price_for(model)["out"] / 1_000_000


# --- GitHub interaction classification ---
_GH_RE = re.compile(r"\bgh\b|\bgit\b|github\.com")

# command-type classifier: ordered (first match wins) over a normalized command string
_CMD_RULES = [
    ("gh pr",       re.compile(r"\bgh\s+pr\b")),
    ("gh api",      re.compile(r"\bgh\s+api\b")),
    ("gh run",      re.compile(r"\bgh\s+run\b")),
    ("gh issue",    re.compile(r"\bgh\s+issue\b")),
    ("gh (other)",  re.compile(r"\bgh\b")),
    ("git push",    re.compile(r"\bgit\b[^|&;]*\bpush\b")),
    ("git fetch",   re.compile(r"\bgit\b[^|&;]*\bfetch\b")),
    ("git pull",    re.compile(r"\bgit\b[^|&;]*\bpull\b")),
    ("git commit",  re.compile(r"\bgit\b[^|&;]*\bcommit\b")),
    ("git diff",    re.compile(r"\bgit\b[^|&;]*\bdiff\b")),
    ("git log",     re.compile(r"\bgit\b[^|&;]*\blog\b")),
    ("git status",  re.compile(r"\bgit\b[^|&;]*\bstatus\b")),
    ("git add",     re.compile(r"\bgit\b[^|&;]*\badd\b")),
    ("git checkout",re.compile(r"\bgit\b[^|&;]*\b(checkout|switch)\b")),
    ("git branch",  re.compile(r"\bgit\b[^|&;]*\bbranch\b")),
    ("git (other)", re.compile(r"\bgit\b")),
]


def classify_command(cmd):
    for label, rx in _CMD_RULES:
        if rx.search(cmd):
            return label
    return "git/gh (uncat)"


def github_blocks(content):
    """Return [(tool_use_id, command-type label)] for each GitHub tool_use in a turn."""
    out = []
    if not isinstance(content, list):
        return out
    for b in content:
        if not isinstance(b, dict) or b.get("type") != "tool_use":
            continue
        name, inp, tid = b.get("name"), b.get("input", {}) or {}, b.get("id")
        if name == "Bash":
            raw_cmd = inp.get("command")
            cmd = (raw_cmd if isinstance(raw_cmd, str) else "").lower()
            if _GH_RE.search(cmd):
                out.append((tid, classify_command(cmd)))
        elif name == "WebFetch":
            raw_url = inp.get("url")
            url = (raw_url if isinstance(raw_url, str) else "").lower()
            if "github.com" in url:
                out.append((tid, "webfetch github"))
        elif name == "Skill" and "ghreview" in str(inp.get("skill", "")):
            out.append((tid, "skill ghreview"))
    return out


CHARS_PER_TOKEN = 4.0  # rough estimate; transcripts don't store per-result token counts


def result_sizes(content):
    """From a user message's content, return {tool_use_id: estimated_tokens}."""
    sizes = {}
    if not isinstance(content, list):
        return sizes
    for b in content:
        if isinstance(b, dict) and b.get("type") == "tool_result":
            c = b.get("content")
            txt = c if isinstance(c, str) else json.dumps(c, default=str)
            sizes[b.get("tool_use_id")] = len(txt) / CHARS_PER_TOKEN
    return sizes


def ctx_size(usage):
    """Total prompt tokens for a turn = input + cache_read + cache_creation."""
    if not usage:
        return 0
    cc = usage.get("cache_creation") or {}
    cc_tokens = cc.get("ephemeral_5m_input_tokens", 0) + cc.get("ephemeral_1h_input_tokens", 0)
    if not cc_tokens:  # older records: flat field
        cc_tokens = usage.get("cache_creation_input_tokens", 0)
    return (usage.get("input_tokens", 0)
            + usage.get("cache_read_input_tokens", 0)
            + cc_tokens)


def is_in_window(ts_str, since, until):
    """True if a turn's timestamp falls within [since, until)."""
    if since is None and until is None:
        return True
    ts = parse_ts(ts_str)
    if ts is None:
        return False
    if since is not None and ts < since:
        return False
    if until is not None and ts >= until:
        return False
    return True


def parse_ts(s):
    """ISO8601 -> epoch seconds (UTC), tolerant of trailing Z."""
    if not s:
        return None
    try:
        s = s.replace("Z", "+00:00")
        return datetime.fromisoformat(s).timestamp()
    except Exception:
        return None


def main():
    ap = argparse.ArgumentParser(description="Estimate GitHub-interaction spend in Claude Code sessions.")
    ap.add_argument("--projects-dir", default=os.path.expanduser("~/.claude/projects"))
    ap.add_argument("--filter", default="", help="only project dirs whose name contains this substring")
    ap.add_argument("--since", help="YYYY-MM-DD (UTC); include turns on/after this date")
    ap.add_argument("--until", help="YYYY-MM-DD (UTC); include turns strictly before this date")
    ap.add_argument("--json", metavar="PATH", help="write full results as JSON")
    ap.add_argument("--csv-commands", metavar="PATH", help="write per-command-type table as CSV")
    ap.add_argument("--explain", action="store_true", help="print methodology and exit")
    args = ap.parse_args()

    if args.explain:
        print(__doc__)
        print(METHODOLOGY)
        return

    since = parse_ts(args.since + "T00:00:00+00:00") if args.since else None
    until = parse_ts(args.until + "T00:00:00+00:00") if args.until else None
    if args.since and since is None:
        ap.error("--since must be YYYY-MM-DD")
    if args.until and until is None:
        ap.error("--until must be YYYY-MM-DD")

    proj_dirs = sorted(
        d for d in glob.glob(os.path.join(args.projects_dir, "*"))
        if os.path.isdir(d) and args.filter in os.path.basename(d)
    )

    total = 0.0
    gh_full = 0.0    # bound (A): full cost of github-touching turns
    gh_out = 0.0     # bound (B): output-token cost of those turns
    gh_ingest = 0.0  # estimate (C): result-ingestion cost (write once + lifetime reads)
    gh_result_tok = 0.0
    persist_ks = []
    n_turns = n_gh = 0
    by_model = defaultdict(float)
    by_project = defaultdict(lambda: dict(total=0.0, gh_full=0.0, gh_out=0.0, gh_ingest=0.0, gh_turns=0))
    by_cmd = defaultdict(lambda: dict(count=0, out_cost=0.0, ingest_cost=0.0))

    PERSIST_SLACK = 0.85  # a result is "still live" while ctx stays >= this * entry-ctx

    for pd in proj_dirs:
        proj = os.path.basename(pd)
        for f in glob.glob(os.path.join(pd, "*.jsonl")):
            # ---- pass 1: parse session in order ----
            turns = []          # ordered assistant turns (full, unfiltered — needed for persistence walk)
            res_tok = {}         # tool_use_id -> estimated result tokens
            try:
                fh = open(f, errors="replace")
            except OSError:
                continue
            with fh:
                for line in fh:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        d = json.loads(line)
                    except Exception:
                        continue
                    t = d.get("type")
                    if t == "assistant":
                        msg = d.get("message", {})
                        usage, model = msg.get("usage"), msg.get("model")
                        turns.append(dict(
                            model=model, usage=usage,
                            cost=turn_cost(usage, model), out=output_cost(usage, model),
                            ctx=ctx_size(usage), gh=github_blocks(msg.get("content", [])),
                            is_in_window=is_in_window(d.get("timestamp"), since, until),
                        ))
                    elif t == "user":
                        res_tok.update(result_sizes(d.get("message", {}).get("content", [])))

            # ---- pass 2: aggregate + ingestion ----
            for i, tn in enumerate(turns):
                if not tn["is_in_window"]:
                    continue
                total += tn["cost"]
                n_turns += 1
                by_model[tn["model"] or "?"] += tn["cost"]
                by_project[proj]["total"] += tn["cost"]
                if not tn["gh"]:
                    continue
                n_gh += 1
                gh_full += tn["cost"]
                gh_out += tn["out"]
                by_project[proj]["gh_full"] += tn["cost"]
                by_project[proj]["gh_out"] += tn["out"]
                by_project[proj]["gh_turns"] += 1
                share = tn["out"] / len(tn["gh"])
                p = price_for(tn["model"])
                for tid, lab in tn["gh"]:
                    by_cmd[lab]["count"] += 1
                    by_cmd[lab]["out_cost"] += share
                    # ---- ingestion: write once at the next turn, then read until evicted ----
                    est = res_tok.get(tid, 0.0)
                    if est <= 0 or i + 1 >= len(turns):
                        continue  # no result, or result never re-enters context (last turn)
                    baseline = turns[i + 1]["ctx"]
                    if baseline <= 0:
                        continue  # missing usage on entry turn — can't estimate persistence
                    gh_result_tok += est
                    write_cost = est * p["cw5"] / 1_000_000
                    k_reads = 0
                    j = i + 2
                    # only count reads on in-window turns so (C) stays consistent with the windowed TOTAL
                    while j < len(turns) and turns[j]["is_in_window"] and turns[j]["ctx"] >= PERSIST_SLACK * baseline:
                        k_reads += 1
                        j += 1
                    read_cost = est * p["cr"] * k_reads / 1_000_000
                    ingest = write_cost + read_cost
                    gh_ingest += ingest
                    by_cmd[lab]["ingest_cost"] += ingest
                    by_project[proj]["gh_ingest"] += ingest
                    persist_ks.append(k_reads)

    avg_k = (sum(persist_ks) / len(persist_ks)) if persist_ks else 0.0

    # ---- stdout report ----
    print(f"projects scanned : {len(proj_dirs)}  (filter={args.filter!r})")
    if args.since or args.until:
        print(f"date window      : {args.since or '-inf'} .. {args.until or '+inf'} (UTC)")
    print(f"assistant turns  : {n_turns:,}")
    pct = (100 * n_gh / n_turns) if n_turns else 0
    print(f"github-touching  : {n_gh:,}  ({pct:.1f}% of turns)")
    print()
    print(f"TOTAL spend (priced)                         : ${total:,.2f}")
    for m, v in sorted(by_model.items(), key=lambda x: -x[1]):
        print(f"    {m:26s} ${v:,.2f}")
    print()
    a_pct = (100 * gh_full / total) if total else 0
    b_pct = (100 * gh_out / total) if total else 0
    c_pct = (100 * gh_ingest / total) if total else 0
    print("GitHub attribution:")
    print(f"  (A) full cost of github turns   : ${gh_full:,.2f}  ({a_pct:.1f}%)   [upper — includes whole-context cache reads]")
    print(f"  (C) result-ingestion cost       : ${gh_ingest:,.2f}  ({c_pct:.1f}%)   [best estimate — github result tokens, written once + read until evicted]")
    print(f"  (B) output tokens of those turns: ${gh_out:,.2f}  ({b_pct:.1f}%)   [lower — cost of writing the command only]")
    print(f"      ~{gh_result_tok/1_000_000:.1f}M result tokens ingested; avg persistence {avg_k:.1f} subsequent turns")
    print()
    print("By command type:")
    print(f"  {'command':18s} {'count':>7s} {'out-cost':>10s} {'ingest-cost':>12s}")
    for lab, v in sorted(by_cmd.items(), key=lambda x: -x[1]["ingest_cost"]):
        print(f"  {lab:18s} {v['count']:>7,} {('$%.2f' % v['out_cost']):>10s} {('$%.2f' % v['ingest_cost']):>12s}")

    if args.json:
        with open(args.json, "w") as out:
            json.dump({
                "total": total, "gh_full_A": gh_full, "gh_ingest_C": gh_ingest, "gh_out_B": gh_out,
                "gh_result_tokens": gh_result_tok, "avg_persistence_turns": avg_k,
                "n_turns": n_turns, "n_gh": n_gh,
                "by_model": dict(by_model),
                "by_project": {k: v for k, v in by_project.items()},
                "by_command": {k: v for k, v in by_cmd.items()},
            }, out, indent=2)
        print(f"\nwrote {args.json}")

    if args.csv_commands:
        with open(args.csv_commands, "w") as out:
            out.write("command_type,count,output_cost_usd,ingest_cost_usd\n")
            for lab, v in sorted(by_cmd.items(), key=lambda x: -x[1]["ingest_cost"]):
                out.write(f"{lab},{v['count']},{v['out_cost']:.4f},{v['ingest_cost']:.4f}\n")
        print(f"wrote {args.csv_commands}")


METHODOLOGY = """
METHODOLOGY & CAVEATS
---------------------
Each assistant turn's usage block (input / cache-creation / cache-read / output
tokens) is priced at standard API rates per model. A turn is 'GitHub-touching'
if it issues: a Bash command containing `gh`/`git`/github.com, a WebFetch to
github.com, or the ghreview skill.

'How much was spent on GitHub' has no exact answer because of CACHE ACCUMULATION:
  - Bound (A) overcounts: a github turn's cache_read is the ENTIRE conversation
    context, not just github content.
  - Bound (B) undercounts: it ignores the cost of reading tool results back into
    context on later turns.

ESTIMATE (C) — RESULT INGESTION — is the best single figure, sitting between the
bounds. It isolates the tokens that are genuinely GitHub-origin: the output of
each gh/git/WebFetch command that lands in context.

  For each GitHub tool_result:
    est_tokens   = len(result_text) / 4          # transcripts store no token count
    write_cost   = est_tokens x cache_write_5m_price            # written to cache once
    read_cost    = est_tokens x cache_read_price x K           # re-read K more turns
    ingest_cost  = write_cost + read_cost

  K (persistence) is DATA-DRIVEN, not guessed: a turn's total prompt size is
  recorded (input + cache_read + cache_creation). The result is counted as 'live'
  for each subsequent turn whose context stays >= 85% of the context size when the
  result entered. The first turn that drops below that — a /clear or compaction —
  ends the result's life. This naturally caps long-session overcounting.

  This captures the downstream tax (A) and (B) miss: a `gh pr view` dumping a big
  diff costs cache reads on every later turn until it's evicted.

Known approximations in (C): tokens are estimated at 4 chars/token (no exact
count in transcripts); reads are priced at the issuing turn's model; the 85%
slack and eviction heuristic approximate real compaction. Treat it as a
well-grounded estimate, not a billed figure. The per-command columns rank which
ops cost most. Pricing assumes standard tier; batch/promotional rates differ.
"""

if __name__ == "__main__":
    main()
