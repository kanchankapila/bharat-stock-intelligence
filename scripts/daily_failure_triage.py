#!/usr/bin/env python3
"""Surface every job/step failure from the last N days -- the ones nothing else reports.

The gap this closes: 125 of ~148 steps in queues.ts are bare
`await runPython(...).catch(e => console.warn(...))`, i.e. NOT wrapped in StepTracker's `T.run()`.
StepTracker correctly marks a job 'failed' when a step it tracks fails -- but it only tracks 23.
The other 125 failures are logged and then invisible: the job reports success, job_heartbeat is
clean, and no data-quality check covers them. That is the "silent failure" class.

Those failures ARE captured -- `console.warn` lands in logs/error-YYYY-MM-DD.log as structured
JSON. Nobody was reading them, which is why they surfaced only in an occasional manual weekly
review, one weekend at a time. This turns that review into something runnable in seconds, daily.

Deliberately NOT a rewrite of queues.ts: wrapping 125 call sites in T.run is the more complete
fix, but it is a large mechanical edit to a hot file that several sessions edit concurrently.
This gets the same visibility with zero risk to the job chain, and the static check in
check_recurring_bugs.py stops NEW untracked steps being added.

    python scripts/daily_failure_triage.py            # today + yesterday
    python scripts/daily_failure_triage.py --days 7   # the weekly review, automated
    python scripts/daily_failure_triage.py --new-only # only failures not seen before the window
"""
import argparse
import collections
import datetime
import gzip
import json
import os
import re
import sys

LOG_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "logs")

# Failures that are known-benign upstream conditions, not defects to chase. Each needs a reason;
# an unexplained entry here is how a real defect gets permanently muted.
MUTED = {
    # AMFI's portfolio endpoint returns the scheme master, not holdings -- upstream, documented in
    # mf_sector_flow_fetcher.py, exits 1 deliberately so it stays visible rather than silent.
    "mf_sector_flow_fetcher.py",
}


def _read(path):
    op = gzip.open if path.endswith(".gz") else open
    try:
        with op(path, "rt", encoding="utf-8", errors="replace") as f:
            for line in f:
                line = line.strip()
                if line:
                    yield line
    except OSError:
        return


def collect(days):
    today = datetime.date.today()
    events = []
    for i in range(days):
        d = (today - datetime.timedelta(days=i)).isoformat()
        for suffix in (".log", ".log.gz"):
            p = os.path.join(LOG_DIR, f"error-{d}{suffix}")
            if not os.path.exists(p):
                continue
            for line in _read(p):
                try:
                    e = json.loads(line)
                except Exception:
                    continue
                msg = (e.get("message") or "").strip()
                if not msg:
                    continue
                # [QUEUE] <job>:<step> failed: ... / [PY] <script> encountered an error / [X] ... failed
                if re.search(r"\bfailed\b|encountered an error|Timed out after", msg, re.I):
                    events.append({
                        "day": d,
                        "script": e.get("script") or "",
                        "msg": re.sub(r"\s+", " ", msg)[:160],
                        "stderr": re.sub(r"\s+", " ", (e.get("stderrSnippet") or ""))[:200],
                    })
    return events


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=2)
    ap.add_argument("--new-only", action="store_true",
                    help="only failures with no occurrence before the window (regressions, not standing issues)")
    ap.add_argument("--json", action="store_true",
                    help="machine-readable stdout for queues.ts's data-quality-daily step -- "
                         "no human-readable printing, always exits 0 (the caller decides severity "
                         "from the payload, not from this process's exit code)")
    args = ap.parse_args()

    events = collect(args.days)
    if not events:
        if args.json:
            print("[]")
            return 0
        print(f"No job/step failures in the last {args.days} day(s).")
        return 0

    # Group by a stable signature so 200 repeats of one broken fetcher are one line, not 200.
    # [QUEUE] job failed: <arbitrary stderr tail> messages carry a variable-length, variable-
    # OFFSET snippet after the colon -- e.g. one run's tail starts mid-word at "nical-analysis/",
    # another at "echnical-analysis/", because they're truncated at a fixed length from a
    # growing multi-line blob, not from a fixed logical start. Normalizing digits alone does not
    # merge these (the surrounding text differs, not just the numbers), so [QUEUE] messages are
    # keyed on the job name up to "failed:" -- the one part guaranteed stable -- rather than the
    # full message. Non-[QUEUE] messages (PY scripts, [SENTIMENT] etc.) keep the digit-normalized
    # full-message key, which is stable for them since their prefix is fixed.
    queue_re = re.compile(r"^\[QUEUE\]\s+(\S+)\s+failed:")
    groups = collections.defaultdict(lambda: {"n": 0, "days": set(), "sample": ""})
    for e in events:
        qm = queue_re.match(e["msg"])
        if e["script"]:
            key = e["script"]
        elif qm:
            key = f"[QUEUE] {qm.group(1)} failed"
        else:
            key = re.sub(r"[0-9]+", "N", e["msg"])[:90]
        g = groups[key]
        g["n"] += 1
        g["days"].add(e["day"])
        if not g["sample"]:
            g["sample"] = e["stderr"] or e["msg"]

    if args.new_only:
        older = {(x["script"] or re.sub(r"[0-9]+", "N", x["msg"])[:90]) for x in collect(args.days + 21)
                 if x["day"] not in {e["day"] for e in events}}
        groups = {k: v for k, v in groups.items() if k not in older}
        if not groups:
            if args.json:
                print("[]")
                return 0
            print(f"No NEW failure signatures in the last {args.days} day(s) (nothing that wasn't already failing).")
            return 0

    actionable_groups = [(k, g) for k, g in groups.items() if k not in MUTED]

    if args.json:
        # Only the actionable (non-muted) ones -- the caller (queues.ts) folds this straight
        # into the daily digest, which should not repeat a signature the muted list already
        # explains. sample is trimmed further; Telegram's digest has its own length limits.
        print(json.dumps([
            {"key": k, "n": g["n"], "days": len(g["days"]), "sample": (g["sample"] or "")[:150]}
            for k, g in sorted(actionable_groups, key=lambda kv: -kv[1]["n"])
        ]))
        return 0

    print(f"\n{'='*80}\nJOB/STEP FAILURES -- last {args.days} day(s), {len(events)} events in "
          f"{len(groups)} distinct signatures\n{'='*80}")
    for key, g in sorted(groups.items(), key=lambda kv: -kv[1]["n"]):
        tag = "MUTED (known upstream)" if key in MUTED else "ACTIONABLE"
        print(f"\n[{tag}] {key}")
        print(f"   {g['n']} event(s) across {len(g['days'])} day(s): {', '.join(sorted(g['days']))}")
        if g["sample"]:
            print(f"   {g['sample']}")
    print(f"\n{len(actionable_groups)} actionable signature(s). "
          f"These do NOT appear in job_heartbeat: 125 of ~148 queues.ts steps are bare "
          f".catch(console.warn) and never mark their job failed.")
    return 1 if actionable_groups else 0


if __name__ == "__main__":
    sys.exit(main())
