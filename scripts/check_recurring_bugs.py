#!/usr/bin/env python3
"""
Static checks for recurring bug classes documented across this project's architecture
review and incident history (see .claude/rules/recurring-bugs.md, which carries the
recurrence count for each):

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
  4. `x != x` (or `x <> x`) used as a NaN test inside SQL. Postgres defines `NaN = NaN` as
     TRUE so its btree ordering can be total, which makes the portable IEEE self-inequality
     trick match nothing and cheerfully report a NaN-poisoned column "clean". The same
     expression in plain Python is correct and is NOT flagged -- only occurrences in SQL
     context are.
  5. A multi-word Postgres cast (`::double precision`, `::timestamp with time zone`,
     `::character varying`). sqlTranslate's stripPgCasts only matches single-token type
     names, so on the SQLite fallback path it strips `::double` and leaves a dangling
     ` precision`, and the whole query fails -- silently, because the caller gets `{}` back
     rather than an error, which has disabled a gate entirely rather than raising. Use the
     single-token spellings: `::float8`, `::timestamptz`, `::varchar`.
  6. A BullMQ worker whose processor can skip early (market-hours/weekend/holiday guard)
     via a bare `return;`, paired with a `.on('completed', ...)` handler that stamps
     'success' without looking at what the job returned. Recurred independently in 4
     queues (technical-signals, intraday-fetcher, live-screener-collect, trendlyne-
     intraday-scan) -- the first was found and fixed 2026-08-12 after it hid 13 real
     failures behind a green heartbeat for two sessions; the other 3 were found live, in
     the same shape, while building this check. `.ts` only (BullMQ workers are all
     TypeScript); see check_skip_not_success.

Deliberately NOT checked: `float(x or 0)` / `int(x or 0)` on a possibly-NaN column. It is a
real bug class (NaN is truthy, so `nan or 0` is `nan`), but measured against this repo it
matches 50 sites and inspection showed most are legitimate None->0 coercions on DB
aggregates. A check that is ~90% false positive gets ignored within a week and then protects
nothing while looking like it does. Catching it needs type information this script does not
have.

Also deliberately NOT checked: a market-hours/skip guard that returns early with no
follow-on 'success' stamp anywhere nearby (most of them -- see confluence.jobs.ts's
`isConfluenceComputeWindow`, which returns a zero-value result object on purpose and is
correctly not flagged by check 6). Flagging every bare early return near such a guard,
without also confirming a completed-handler stamps success unconditionally, produced a wall
of false positives against this repo's own job files during development -- most jobs here
skip constantly and correctly. Check 6 only fires when both halves of the actual bug shape
are present in the same file.

Checks 4, 5 and 6 all matched zero real occurrences once the known instances were fixed, so
they are regression guards: they exist to stop the class coming back, not to work through a
backlog.

File scope is `src/server/*.py` for checks 1-5, plus `src/server/**/*.ts` (excluding tests)
for check 6 only. The multi-word-cast class (check 5) also occurs in `.ts` (sqlTranslate is
TypeScript); this script does not cover that side.

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
    return _diff_files(ref, staged, "src/server/*.py")


def _diff_files(ref: str | None, staged: bool, pathspec: str) -> list[Path]:
    if staged:
        args = ["git", "diff", "--name-only", "--cached", "--diff-filter=ACM", "--", pathspec]
    else:
        args = ["git", "diff", "--name-only", ref or "HEAD", "--diff-filter=ACM", "--", pathspec]
    out = subprocess.run(args, cwd=REPO_ROOT, capture_output=True, text=True)
    if out.returncode != 0:
        # An unresolvable base ref (all-zero SHA on a new-branch push, or HEAD~1 under a
        # shallow CI clone) used to surface as a raw CalledProcessError traceback.
        raise SystemExit(
            f"cannot diff against {'--cached' if staged else ref or 'HEAD'}: "
            f"{out.stderr.strip()}\nFix the ref, or run with no --diff to scan every tracked file."
        )
    return [REPO_ROOT / line for line in out.stdout.splitlines() if line]


def _tracked_ts_files() -> list[Path]:
    # `:(glob)` pathspec magic turns on `**` (git's default fnmatch doesn't cross `/`),
    # needed since job/router .ts files live in subdirectories, unlike the flat *.py engines.
    out = subprocess.run(
        ["git", "ls-files", ":(glob)src/server/**/*.ts"], cwd=REPO_ROOT,
        capture_output=True, text=True, check=True,
    )
    return [REPO_ROOT / line for line in out.stdout.splitlines()
            if line and "test" not in Path(line).name.lower()]


def _diff_ts_files(ref: str | None, staged: bool) -> list[Path]:
    files = _diff_files(ref, staged, ":(glob)src/server/**/*.ts")
    return [f for f in files if "test" not in f.name.lower()]


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
    # Test plumbing is exempt: its `%s` are raw psycopg2 placeholders on a real cursor, not
    # db_compat-mediated calls. `conftest.py`/`pg_test_support.py` are named explicitly because
    # they sit in `src/server/`, not `src/server/tests/` -- moved there 2026-08-17 so the
    # fixtures also cover `src/server/__tests__/`, which promptly made this check fire on two
    # correct pre-existing lines.
    if "tests" in path.parts or path.name in ("conftest.py", "pg_test_support.py"):
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
    # Second alternative: a triple-quoted SQL block closed and immediately `%`-formatted on
    # the same line (`""" % int(lookback_days)`), which the line-start form misses -- the one
    # false positive this checker produced against the repo (feature_coverage_gate.py:64).
    # Kept narrow to the triple-quote spelling on purpose: widening it to any closing quote
    # would also swallow a genuine placeholder in a query containing a quoted '%s' LIKE
    # pattern.
    percent_format_re = re.compile(r'^\s*%\s*[\("\']|\.format\(|(?:"""|\'\'\')\s*%\s*[\w(\[]')
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


_TRIPLE_RE = re.compile(r'"""|\'\'\'')


def _code_lines(text: str):
    """Yield (index, line) for lines that are actual code -- skipping `#` comments and
    anything inside (or on the boundary line of) a triple-quoted string. Prose describing a
    bug is not the bug; both checks below have their only repo-wide "matches" in exactly
    such prose."""
    in_docstring = False
    for i, line in enumerate(text.splitlines()):
        was_in = in_docstring
        n_triples = len(_TRIPLE_RE.findall(line))
        if n_triples % 2 == 1:
            in_docstring = not in_docstring
        if line.strip().startswith("#") or was_in or n_triples > 0:
            continue
        yield i, line


# A self-inequality is only a bug in SQL; `f != f` in plain Python is a correct NaN test and
# is used deliberately in ~10 fetchers here. Requiring a SQL keyword in the surrounding
# window is what separates the two.
_SELF_INEQ_RE = re.compile(r"\b([A-Za-z_][\w.]*)\s*(?:!=|<>)\s*\1\b")
_SQL_CONTEXT_RE = re.compile(r"\b(SELECT|WHERE|CASE|HAVING|UPDATE|DELETE|JOIN)\b")


def check_nan_self_inequality(path: Path, text: str) -> list[str]:
    if "tests" in path.parts:
        return []
    findings = []
    lines = text.splitlines()
    for i, line in _code_lines(text):
        if not _SELF_INEQ_RE.search(line):
            continue
        window = "\n".join(lines[max(0, i - 6):i + 4])
        if not _SQL_CONTEXT_RE.search(window):
            continue  # plain Python NaN check -- correct, and used on purpose here
        findings.append(
            f"{_display_path(path)}:{i + 1}: `x != x` used as a NaN test inside SQL -- "
            f"Postgres defines NaN = NaN as TRUE (its btree ordering is total), so this "
            f"matches nothing and reports a NaN-poisoned column clean. Compare on the text "
            f"cast instead; see data_integrity_repair.py for the dialect-specific form."
        )
    return findings


_MULTIWORD_CAST_RE = re.compile(
    r"::\s*(double precision|timestamp with time zone|timestamp without time zone|character varying)",
    re.IGNORECASE,
)
_CAST_FIX = {
    "double precision": "::float8",
    "timestamp with time zone": "::timestamptz",
    "timestamp without time zone": "::timestamp",
    "character varying": "::varchar",
}


def check_multiword_pg_cast(path: Path, text: str) -> list[str]:
    if "tests" in path.parts:
        return []
    findings = []
    for i, line in _code_lines(text):
        m = _MULTIWORD_CAST_RE.search(line)
        if not m:
            continue
        found = m.group(1).lower()
        findings.append(
            f"{_display_path(path)}:{i + 1}: multi-word Postgres cast `::{found}` -- "
            f"sqlTranslate's stripPgCasts only matches single-token type names, so the "
            f"SQLite fallback path strips `::{found.split()[0]}` and leaves a dangling "
            f"` {found.split(' ', 1)[1]}`, failing the whole query silently (the caller gets "
            f"{{}} back, which has disabled a gate rather than raised). Use "
            f"`{_CAST_FIX[found]}`."
        )
    return findings


def _extract_braced_body(text: str, open_idx: int) -> str | None:
    """Given the index of an opening '{' in text, return the substring up to and including
    its matching '}'. A brace-depth walk, not a real parser -- good enough for this repo's
    style of Worker/`.on('completed', ...)` callbacks, same tradeoff as the paren-depth walk
    in check_raw_percent_s above."""
    depth = 0
    for i in range(open_idx, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_idx:i + 1]
    return None


_WORKER_CTOR_RE = re.compile(r"(\w+)\s*=\s*new\s+Worker\s*\(\s*[\w.]+\s*,\s*")
_INLINE_PROCESSOR_RE = re.compile(r"\s*(?:async\s*)?\([^)]*\)\s*(?::[^{=]*)?=>\s*\{")
_NAMED_PROCESSOR_REF_RE = re.compile(r"\s*(\w+)\s*,")
_SKIP_GUARD_RE = re.compile(
    r"if\s*\([^)]*\b(isMarketOpen|marketHours|tradingHours|isWeekend|isHoliday)\b", re.IGNORECASE
)
_BARE_RETURN_RE = re.compile(r"\breturn\s*(undefined\s*)?;")
_OBJECT_RETURN_RE = re.compile(r"\breturn\s*\{")
_STAMP_SUCCESS_RE = re.compile(r"(?:recordHeartbeat|updateMonitorState)\s*\([^)]*['\"]success['\"]")
_RESULT_SKIP_CHECK_RE = re.compile(r"\bresult\b.*\bskip", re.IGNORECASE | re.DOTALL)


def _processor_has_bare_skip_return(body: str) -> bool:
    """True if `body` has a market-hours/weekend/holiday guard whose branch returns bare
    (`return;`) rather than a distinguishable object. An object-literal return -- even one
    that isn't literally `{ skipped: true }` -- is treated as already distinguishable and
    not flagged: several legitimate jobs in this repo (e.g. confluence.jobs.ts's
    isConfluenceComputeWindow skip) return a zero-value result object on purpose."""
    for m in _SKIP_GUARD_RE.finditer(body):
        brace_idx = body.find("{", m.end())
        if brace_idx == -1:
            continue
        block = _extract_braced_body(body, brace_idx)
        if block is None or _OBJECT_RETURN_RE.search(block):
            continue  # no guard body found, or it already returns a marker -- not the bug
        if _BARE_RETURN_RE.search(block):
            return True
    return False


def check_skip_not_success(path: Path, text: str) -> list[str]:
    """See class 6 in the module docstring. Deliberately narrow: fires only when a worker's
    processor has the bare-return skip shape AND that worker's own completed handler stamps
    'success' without checking the result -- both halves have to be present in the same
    file. A processor that skips via a distinguishable object return, or a completed handler
    that already checks `result`, is not flagged."""
    findings = []
    for m in _WORKER_CTOR_RE.finditer(text):
        worker_var = m.group(1)
        after_ctor = text[m.end():]

        proc_body = None
        inline_m = _INLINE_PROCESSOR_RE.match(after_ctor)
        if inline_m:
            proc_body = _extract_braced_body(after_ctor, inline_m.end() - 1)
        else:
            name_m = _NAMED_PROCESSOR_REF_RE.match(after_ctor)
            if name_m:
                fn_re = re.compile(
                    rf"\basync\s+function\s+{re.escape(name_m.group(1))}\s*\([^)]*\)[^{{]*\{{"
                )
                fn_m = fn_re.search(text)
                if fn_m:
                    proc_body = _extract_braced_body(text, fn_m.end() - 1)

        if not proc_body or not _processor_has_bare_skip_return(proc_body):
            continue

        handler_re = re.compile(
            rf"\b{re.escape(worker_var)}\.on\(\s*['\"]completed['\"]\s*,\s*"
            rf"(?:async\s*)?\([^)]*\)\s*(?::[^{{=]*)?=>\s*\{{"
        )
        handler_m = handler_re.search(text)
        if not handler_m:
            continue
        handler_body = _extract_braced_body(text, handler_m.end() - 1)
        if handler_body is None or not _STAMP_SUCCESS_RE.search(handler_body):
            continue
        if _RESULT_SKIP_CHECK_RE.search(handler_body):
            continue  # already guards on the result -- fixed

        findings.append(
            f"{_display_path(path)}: worker '{worker_var}' processor can skip via a bare "
            f"`return;` on a market-hours/weekend/holiday guard, but its .on('completed', ...) "
            f"handler stamps 'success' unconditionally -- the skip overwrites that queue's "
            f"real last outcome. Return a marker (`{{ skipped: true }}`) from the processor "
            f"and check it in the completed handler before stamping, same fix as technical-"
            f"signals/intraday-fetcher/live-screener-collect/trendlyne-intraday-scan "
            f"(2026-08-12)."
        )
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
        resolved = [Path(p).resolve() for p in args.paths]
        py_files = [f for f in resolved if f.suffix == ".py" and f.exists()]
        ts_files = [f for f in resolved if f.suffix == ".ts" and f.exists() and "test" not in f.name.lower()]
    elif args.diff is not None or args.staged:
        py_files = [f for f in _diff_python_files(args.diff, args.staged) if f.exists()]
        ts_files = [f for f in _diff_ts_files(args.diff, args.staged) if f.exists()]
    else:
        py_files = [f for f in _tracked_python_files() if f.exists()]
        ts_files = [f for f in _tracked_ts_files() if f.exists()]

    all_findings: list[str] = []
    for path in py_files:
        text = path.read_text(encoding="utf-8", errors="ignore")
        all_findings.extend(check_date_anchor(path, text))
        all_findings.extend(check_raw_percent_s(path, text))
        all_findings.extend(check_nan_self_inequality(path, text))
        all_findings.extend(check_multiword_pg_cast(path, text))

    for path in ts_files:
        all_findings.extend(check_skip_not_success(path, path.read_text(encoding="utf-8", errors="ignore")))

    if not args.skip_live_datasource_check:
        all_findings.extend(check_missing_live_datasource_test(py_files))

    if all_findings:
        print(f"Found {len(all_findings)} potential issue(s) from the recurring-bug checklist:\n")
        for f in all_findings:
            print(f"  - {f}")
        print("\nThese are heuristic checks (a few hours of tooling, not a compiler) -- review "
              "each one; a false positive is possible, but every one of these patterns "
              "has, historically, been a real bug when it appeared.")
        return 1

    print(f"Checked {len(py_files)} python + {len(ts_files)} ts file(s); no matches for the "
          f"recurring-bug patterns.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
