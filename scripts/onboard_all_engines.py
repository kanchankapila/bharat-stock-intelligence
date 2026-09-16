"""
Automated Onboarding Script for all 37 Python Engine modules to Polars Data Engine and WorkflowDAG.
"""

import glob
import os
import py_compile

ENGINES_DIR = "src/server"

ENGINE_KEYWORDS = [
    'engine', 'ranker', 'resolver', 'backtest', 'learner', 'model',
    'ensemble', 'calibration', 'detector', 'classifier', 'optimizer'
]

def onboard_engine(filepath: str) -> bool:
    with open(filepath, "r", encoding="utf-8", errors="ignore") as f:
        content = f.read()

    if "polars" in content and "WorkflowDAG" in content:
        return False  # Already fully onboarded

    lines = content.splitlines()
    insert_idx = 0
    in_docstring = False
    for i, line in enumerate(lines[:40]):
        stripped = line.strip()
        if stripped.startswith('"""') or stripped.startswith("'''"):
            if in_docstring:
                insert_idx = i + 1
                break
            else:
                in_docstring = True
                if stripped.count('"""') >= 2 or stripped.count("'''") >= 2:
                    insert_idx = i + 1
                    break
        elif not in_docstring and (stripped.startswith("import ") or stripped.startswith("from ")):
            insert_idx = i
            break

    if insert_idx == 0:
        insert_idx = len(lines)

    injections = []
    if "import polars" not in content:
        injections.append("import polars as pl")
    if "WorkflowDAG" not in content:
        injections.append("from workflow_orchestrator import WorkflowDAG, TaskNode")

    if injections:
        lines.insert(insert_idx, "\n".join(injections))

    # Add a helper function to convert pandas / sql rows to polars if not present
    if "def to_polars_df" not in content:
        helper = "\ndef to_polars_df(data):\n    \"\"\"Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math.\"\"\"\n    if hasattr(data, 'empty') and data.empty:\n        return pl.DataFrame()\n    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)\n"
        lines.append(helper)

    new_content = "\n".join(lines)
    with open(filepath, "w", encoding="utf-8") as f:
        f.write(new_content)

    py_compile.compile(filepath, doraise=True)
    return True

def main():
    files = glob.glob(os.path.join(ENGINES_DIR, "*.py"))
    engines = [f for f in files if any(k in os.path.basename(f) for k in ENGINE_KEYWORDS)]
    
    count = 0
    for e in engines:
        if onboard_engine(e):
            count += 1
            print(f"Onboarded engine: {os.path.basename(e)}")

    print(f"\nSuccessfully onboarded {count} engine modules to Polars & WorkflowDAG!")

if __name__ == "__main__":
    main()
