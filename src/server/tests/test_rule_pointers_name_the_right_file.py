"""AF-20260927-05: recurring-bugs.md is an index; its sections live in the bugs-*.md area files.
A live instruction file that names a moved section as being in recurring-bugs.md sends the reader
to a file that does not hold it. Derived from the index's own routing table and `git ls-files`."""
import os
import re
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", ".."))
SCOPE = [".claude/commands", ".claude/skills", ".claude/rules", "CLAUDE.md", "AGENTS.md",
         "CONTEXT.md", "docs/agent-operations.md"]


def moved_sections():
    idx = open(os.path.join(ROOT, ".claude/rules/recurring-bugs.md"), encoding="utf-8").read()
    rows = re.findall(r"^\| (.+?) \| `(bugs-[a-z-]+\.md)`", idx, re.M)
    return [(t.strip(), home) for t, home in rows if len(t.strip()) < 60]


def stale_pointers(text, sections):
    hits = []
    for n, line in enumerate(text.splitlines(), 1):
        for m in re.finditer(r"recurring-bugs\.md", line):
            window = line[max(0, m.start() - 120): m.end() + 120]
            for title, home in sections:
                if title.lower() in window.lower() and home not in window:
                    hits.append((n, title, home))
    return hits


def test_scanner_flags_a_moved_section_named_in_the_index_file():
    sections = moved_sections()
    assert len(sections) >= 8, "routing table not parsed; the index layout changed"
    title, home = sections[0]
    assert stale_pointers(f'see the "{title}" cluster in recurring-bugs.md', sections)
    assert not stale_pointers(f'see the "{title}" section of {home} (index: recurring-bugs.md)', sections)
    assert not stale_pointers("skim recurring-bugs.md before writing SQL", sections)


def test_no_live_instruction_file_points_a_moved_section_at_the_index():
    sections = moved_sections()
    files = [f for f in subprocess.run(["git", "ls-files", *SCOPE], cwd=ROOT, capture_output=True,
                                       text=True, check=True).stdout.split()
             if f.endswith(".md") and not f.endswith("rules/recurring-bugs.md")]
    assert len(files) > 20, "scope resolved to almost nothing; the scan would pass vacuously"
    bad = []
    for f in files:
        text = open(os.path.join(ROOT, f), encoding="utf-8", errors="replace").read()
        bad += [f"{f}:{n}: '{title}' lives in {home}" for n, title, home in stale_pointers(text, sections)]
    assert not bad, "\n".join(bad)
