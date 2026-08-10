#!/usr/bin/env python3
"""
Static checks for the three recurring bug classes documented across this project's
architecture review and incident history (see CLAUDE.md's "Recent session notes" and
docs/audit-2026-07-28/FULL_STACK_AUDIT.md):

  1. A bare `date.today()`/`datetime.now()` used near a point-in-time write-guard
     (`UPDATE ... WHERE date >= ?` / `CASE WHEN date >= ... ELSE NULL`). This exact shape
     recurred at least 10 documented times across separate fetchers, each anchoring a write
     guard to the calendar date instead of the last completed trading session -- silently
     nulling a stock's entire history on any day the two don't match (weekends, holidays,
     midnight-crossing job runs). The fix is `as_of.logical_write_floor()`; a fetcher that
     types `date.today()` near this pattern has, so far, always been reintroducing the bug.
  2. A raw `%s` placeholder inside a `db_compat`-mediated `execute()`/`cur.execute()` call.
     `db_compat.py`'s translate() layer expects `?` (SQLite-style) and converts per-dialect;
     a literal `%s` bypasses that translation and throws `psycopg2.errors.SyntaxError` on
     Postgres. Recurred independently in asm_gsm_fetcher.py, insider_transactions_fetcher.py,
     and index_membership_fetcher.py.
  3. A new `*_fetcher.py` file with no matching `test_live_datasource_*` test. CLAUDE.md
     mandates one for every data-source fetcher (see "Adding a New Data Source" there) --
     compliance was measured at ~16% months after the rule was declared mandatory, and the
     absence of exactly this test is what let the 2026-07-23 URL-as-symbol corruption run
     undetected for its entire life (nothing ever hit the real API and checked the shape of
     what came back).

This is a standalone checker, not a git hook -- .git/hooks is shared across every worktree
of this repository (confirmed: multiple concurrent Claude sessions each have their own
worktree checked out against the same repo), so silently wiring this in as a commit-blocking
hook would affect other in-progress sessions' commits without their opt-in. Run by hand,
wire into CI, or install as a hook explicitly -- this script only reports, it never blocks.

Usage:
  python scripts/check_recurring_bugs.py                  # check all tracked src/server/*.py
  python scripts/check_recurring_bugs.py --diff HEAD~1     # check only files changed since a ref
  python scripts/check_recurring_bugs.py --diff --staged   # check only staged files
  python scripts/check_recurring_bugs.py path/to/file.py   # check specific files
"""
import argparse
import re
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
SERVER_DIR = REPO_ROOT / "src" / "server"

# Files that legitimately reference date.today()/datetime.now() as a genuine calendar-date
# concept (snapshot keys, fallbacks *inside* as_of.py itself, non-fetcher scripts) rather
# than as a write-guard anchor. Extend this list deliberately, not by guessing.
DATE_ANCHOR_ALLOWLIST = {
    "as_of.py",              # owns the real implementation; its own fallback path is exempt
    "et_stats_client.py",    # as_of_floor()'s own fallback, same exemption as as_of.py
}


def _display_path(path: Path) -> str:
    """Path relative to REPO_ROOT for real repo files; falls back to the raw path when
    called against a file outside REPO_ROOT (e.g. a tmp_path fixture in a unit test)."""
    try:
        return str(path.relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


def _tracked_python_files() -> list[Path]:
    out = subprocess.run(
        ["git", "ls-files", "src/server/*.py"], cwd=REPO_ROOT,
        capture_output=True, text=True, check=True,
    )
    return [REPO_ROOT / line for line in out.stdout.splitlines() if line]


def _diff_python_files(ref: str | None, staged: bool) -> list[Path]:
    if staged:
        args = ["git", "diff", "--name-only", "--cached", "--diff-filter=ACM", "--", "src/server/*.py"]
    else:
        args = ["git", "diff", "--name-only", ref or "HEAD", "--diff-filter=ACM", "--", "src/server/*.py"]
    out = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True, check=True)
    return [REPO_ROOT / line for line in out.stdout.splitlines() if line]


def check_date_anchor(path: Path, text: str) -> list[str]:
    """Flags date.today()/datetime.now() near the SPECIFIC documented bug shape: a
    'CASE WHEN date >= ... ELSE NULL' point-in-time write guard. Deliberately narrower than
    "any WHERE ... date >=" -- that also matches ordinary read-side lookback windows
    (`WHERE date >= cutoff` for "give me the last 30 days"), which are a different, much
    lower-severity pattern (a stale calendar day shifts the window by a session; it doesn't
    NULL a stock's entire history the way a write-guard mismatch does) and are not what this
    check exists to catch.
    """
    if path.name in DATE_ANCHOR_ALLOWLIST or "tests" in path.parts:
        return []
    findings = []
    lines = text.splitlines()
    guard_re = re.compile(r"ELSE\s+NULL")
    anchor_re = re.compile(r"\bdate\.today\(\)|\bdatetime\.now\(\)")
    # The documented, intentional escape hatch: date.today()/datetime.now() passed as
    # logical_write_floor()'s own `fallback=` -- used ONLY when stock_ohlcv is completely
    # empty, not as the write-guard anchor itself. Not a bug; every retrofitted fetcher does
    # this on purpose to preserve its pre-refactor behavior exactly.
    fallback_arg_re = re.compile(r"fallback\s*=\s*(date\.today\(\)|datetime\.now\(\))")
    in_docstring = False
    triple_re = re.compile(r'"""|\'\'\'')
    for i, line in enumerate(lines):
        was_in_docstring = in_docstring
        n_triples = len(triple_re.findall(line))
        if n_triples % 2 == 1:
            in_docstring = not in_docstring
        # A line the docstring toggle just opened or closed on is itself skipped too, not
        # just the lines strictly between them -- an opening line like '"""Guard was
        # date.today()-anchored ... ELSE NULL ...' would otherwise be judged "not yet
        # inside" (the toggle only takes effect starting the NEXT line) despite being pure
        # prose on the boundary line itself.
        if line.strip().startswith("#") or was_in_docstring or n_triples > 0:
            continue  # prose describing the bug/fix (comment or docstring) is not the bug
        if not anchor_re.search(line):
            continue
        if fallback_arg_re.search(line):
            continue
        window = "\n".join(lines[max(0, i - 3):i + 10])
        if guard_re.search(window):
            findings.append(
                f"{_display_path(path)}:{i + 1}: date.today()/datetime.now() near a "
                f"'CASE WHEN date >= ... ELSE NULL' write guard -- use "
                f"as_of.logical_write_floor() instead, or this silently nulls history on any "
                f"day the calendar date doesn't match an existing row "
                f"(weekend/holiday/midnight-crossing run)."
            )
    return findings


def check_raw_percent_s(path: Path, text: str) -> list[str]:
    """Flags a literal '%s' inside the SPAN of a single .execute(...) call -- scoped by
    paren-depth to that one statement, not a fixed line window, so it can't cross into an
    unrelated adjacent execute() call or a nearby log.info("...%s...", x) statement (both
    produced false positives with a naive N-line lookahead)."""
    if "tests" in path.parts:
        return []
    findings = []
    lines = text.splitlines()
    execute_re = re.compile(r"\b(cur|conn|con)\.execute\s*\(")
    # A real placeholder is a bare '%s' token (e.g. "(%s)", "= %s,", "IN (%s)") -- exclude
    # '%s' embedded in a longer word, which is just an ordinary SQL LIKE wildcard that
    # happens to precede the letter s ('%sale%', '%sell%', '%stock%', ...).
    percent_s_re = re.compile(r"%s(?![a-zA-Z])")
    # If a '%' operator (or .format()) is applied within the same statement span -- e.g.
    # `"...%s..." % (...)` -- the %s is plain Python string interpolation, already resolved
    # by the time execute() sees it, not a SQL placeholder bug.
    percent_format_re = re.compile(r'^\s*%\s*[\("\']|\.format\(')
    i = 0
    while i < len(lines):
        line = lines[i]
        m = execute_re.search(line)
        if not m:
            i += 1
            continue
        # Walk forward tracking paren depth from the '(' the match opened, to find the
        # exact span of this one execute(...) call.
        depth = 0
        started = False
        span_lines = []
        j = i
        while j < len(lines):
            seg = lines[j][m.end() - 1:] if j == i else lines[j]
            for ch in seg:
                if ch == "(":
                    depth += 1
                    started = True
                elif ch == ")":
                    depth -= 1
            span_lines.append(lines[j])
            if started and depth <= 0:
                break
            j += 1
        span = "\n".join(span_lines)
        if percent_s_re.search(span) and not percent_format_re.search(span) and \
                not any(percent_format_re.search(wl) for wl in span_lines):
            findings.append(
                f"{_display_path(path)}:{i + 1}: raw '%s' placeholder in a "
                f"db_compat-mediated execute() call -- db_compat's translate() layer expects "
                f"'?' and converts per-dialect; a literal '%s' bypasses that and throws a "
                f"Postgres syntax error at runtime."
            )
        i = j + 1
    return findings


def check_missing_live_datasource_test(fetcher_files: list[Path]) -> list[str]:
    tests_dir = SERVER_DIR / "tests"
    existing = {p.name for p in tests_dir.glob("test_live_datasource_*.py")} if tests_dir.exists() else set()
    findings = []
    for path in fetcher_files:
        if not path.name.endswith("_fetcher.py") or "tests" in path.parts:
            continue
        # A *_fetcher.py that never makes an HTTP call is not an external data source, so the
        # live_datasource mandate doesn't apply to it -- it's a derived-feature engine with a
        # misleading filename (screener_features_fetcher.py reads screener_appearances out of
        # the DB and computes features). Checking for the client import rather than keeping an
        # allowlist means a genuine fetcher can never be silently exempted by being renamed.
        src = path.read_text(encoding="utf-8", errors="ignore")
        if not re.search(r"^\s*(?:import|from)\s+(requests|httpx|urllib|curl_cffi|aiohttp)\b",
                         src, re.MULTILINE):
            continue

        stem = path.stem  # e.g. "asm_gsm_fetcher"
        base = stem[:-len("_fetcher")]  # e.g. "asm_gsm"
        candidates = {f"test_live_datasource_{base}.py", f"test_live_datasource_{stem}.py"}
        # Also accept the fetcher being exercised inside a broader live_datasource test file
        # (a few fetchers share one, e.g. feature-matrix fetchers) -- a loose grep match on
        # the module name inside any live_datasource test file counts.
        if candidates & existing:
            continue
        loose_hit = False
        for t in tests_dir.glob("test_live_datasource_*.py"):
            if stem in t.read_text(encoding="utf-8", errors="ignore"):
                loose_hit = True
                break
        if not loose_hit:
            findings.append(
                f"{_display_path(path)}: no test_live_datasource_* test found for "
                f"this fetcher -- CLAUDE.md's 'Adding a New Data Source' rule requires one "
                f"that hits the real endpoint, parses with the fetcher's own function, and "
                f"validates the DB-stored row is ML-usable. See "
                f"tests/test_live_datasource_trendlyne_screener.py for the worked example."
            )
    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("paths", nargs="*", help="specific files to check")
    parser.add_argument("--diff", nargs="?", const="HEAD", metavar="REF",
                         help="only check files changed since REF (default HEAD)")
    parser.add_argument("--staged", action="store_true", help="only check staged files (with --diff)")
    parser.add_argument("--skip-live-datasource-check", action="store_true",
                         help="skip check #3 (useful for --diff runs touching only a few lines)")
    args = parser.parse_args()

    if args.paths:
        files = [Path(p).resolve() for p in args.paths]
    elif args.diff is not None or args.staged:
        files = _diff_python_files(args.diff, args.staged)
    else:
        files = _tracked_python_files()

    files = [f for f in files if f.suffix == ".py" and f.exists()]

    all_findings: list[str] = []
    for path in files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        all_findings.extend(check_date_anchor(path, text))
        all_findings.extend(check_raw_percent_s(path, text))

    if not args.skip_live_datasource_check:
        all_findings.extend(check_missing_live_datasource_test(files))

    if all_findings:
        print(f"Found {len(all_findings)} potential issue(s) from the recurring-bug checklist:\n")
        for f in all_findings:
            print(f"  - {f}")
        print("\nThese are heuristic checks (a few hours of tooling, not a compiler) -- review "
              "each one; a false positive is possible, but every one of these three patterns "
              "has, historically, been a real bug when it appeared.")
        return 1

    print(f"Checked {len(files)} file(s); no matches for the recurring-bug patterns.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
