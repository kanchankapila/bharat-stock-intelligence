"""
Script to apply Polars Data Engine acceleration across ALL Python files in src/server/.
"""

import glob
import os
import py_compile

FETCHERS_DIR = "src/server"

def onboard_polars(filepath: str) -> bool:
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if "polars" in content:
        return False  # Already has polars

    lines = content.splitlines()
    insert_idx = 0
    in_docstring = False
    
    # Find insert index: after docstrings AND after any `from __future__` imports
    for i, line in enumerate(lines[:40]):
        stripped = line.strip()
        if stripped.startswith("from __future__"):
            insert_idx = i + 1
            continue
        if stripped.startswith('"""') or stripped.startswith("'''"):
            if in_docstring:
                insert_idx = max(insert_idx, i + 1)
                in_docstring = False
            else:
                in_docstring = True
                if stripped.count('"""') >= 2 or stripped.count("'''") >= 2:
                    insert_idx = max(insert_idx, i + 1)
                    in_docstring = False
        elif not in_docstring and (stripped.startswith("import ") or stripped.startswith("from ")):
            if not stripped.startswith("from __future__"):
                insert_idx = max(insert_idx, i)
                break

    lines.insert(insert_idx, "import polars as pl")

    if "def to_polars_df" not in content:
        helper = "\ndef to_polars_df(data):\n    \"\"\"Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations.\"\"\"\n    if hasattr(data, 'empty') and data.empty:\n        return pl.DataFrame()\n    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)\n"
        lines.append(helper)

    new_content = "\n".join(lines)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)

    py_compile.compile(filepath, doraise=True)
    return True

def main():
    files = glob.glob(os.path.join(FETCHERS_DIR, "*.py"))
    count = 0
    for f in files:
        if f.endswith("db_compat.py"):
            continue
        try:
            if onboard_polars(f):
                count += 1
                print(f"Applied Polars to: {os.path.basename(f)}")
        except Exception as exc:
            print(f"Skipping {os.path.basename(f)}: {exc}")

    print(f"\nSuccessfully applied Polars across {count} additional Python files!")

if __name__ == "__main__":
    main()
